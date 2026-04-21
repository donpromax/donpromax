const fs = require("fs");
const path = require("path");

const START_MARKER = "<!--START_SECTION:activity-->";
const END_MARKER = "<!--END_SECTION:activity-->";

const ISSUE_ACTION_EMOJIS = {
  opened: "❗",
  reopened: "🔓",
  closed: "🔒",
};

const PR_ACTION_EMOJIS = {
  opened: "💪",
  closed: "❌",
  reopened: "🔓",
};

function capitalize(text) {
  if (!text) {
    return "";
  }

  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function toRepoLink(repo) {
  return `[${repo}](https://github.com/${repo})`;
}

function toIssueLink(repo, number) {
  return `[#${number}](https://github.com/${repo}/issues/${number})`;
}

function toPullRequestLink(repo, number) {
  return `[#${number}](https://github.com/${repo}/pull/${number})`;
}

function formatIssueCommentEvent(event) {
  const repo = event.repo?.name;
  const issue = event.payload?.issue;

  if (!repo || !issue?.number) {
    return null;
  }

  if (issue.pull_request) {
    return `🗣 Commented on PR ${toPullRequestLink(repo, issue.number)} in ${toRepoLink(repo)}`;
  }

  return `🗣 Commented on issue ${toIssueLink(repo, issue.number)} in ${toRepoLink(repo)}`;
}

function formatIssuesEvent(event) {
  const repo = event.repo?.name;
  const issue = event.payload?.issue;
  const action = event.payload?.action;

  if (!repo || !issue?.number || !action) {
    return null;
  }

  const emoji = ISSUE_ACTION_EMOJIS[action] || "ℹ️";
  return `${emoji} ${capitalize(action)} issue ${toIssueLink(repo, issue.number)} in ${toRepoLink(repo)}`;
}

function formatPullRequestEvent(event) {
  const repo = event.repo?.name;
  const pullRequest = event.payload?.pull_request;
  const action = event.payload?.action;

  if (!repo || !pullRequest?.number || !action) {
    return null;
  }

  const merged = action === "closed" && Boolean(pullRequest.merged_at);
  const emoji = merged ? "🎉" : PR_ACTION_EMOJIS[action] || "ℹ️";
  const actionText = merged ? "Merged" : capitalize(action);

  return `${emoji} ${actionText} PR ${toPullRequestLink(repo, pullRequest.number)} in ${toRepoLink(repo)}`;
}

function formatPullRequestReviewCommentEvent(event) {
  const repo = event.repo?.name;
  const pullRequest = event.payload?.pull_request;

  if (!repo || !pullRequest?.number) {
    return null;
  }

  return `💬 Left a review comment on PR ${toPullRequestLink(repo, pullRequest.number)} in ${toRepoLink(repo)}`;
}

function formatPullRequestReviewEvent(event) {
  const repo = event.repo?.name;
  const pullRequest = event.payload?.pull_request;
  const action = event.payload?.action;

  if (!repo || !pullRequest?.number) {
    return null;
  }

  const actionText = action ? `${capitalize(action)} review for` : "Reviewed";
  return `👀 ${actionText} PR ${toPullRequestLink(repo, pullRequest.number)} in ${toRepoLink(repo)}`;
}

function formatReleaseEvent(event) {
  const repo = event.repo?.name;
  const action = event.payload?.action;
  const release = event.payload?.release;

  if (!repo || !action) {
    return null;
  }

  const releaseName = release?.tag_name || release?.name || "release";
  return `🚀 ${capitalize(action)} release [${releaseName}](https://github.com/${repo}/releases) in ${toRepoLink(repo)}`;
}

const FORMATTERS = {
  IssueCommentEvent: formatIssueCommentEvent,
  IssuesEvent: formatIssuesEvent,
  PullRequestEvent: formatPullRequestEvent,
  PullRequestReviewCommentEvent: formatPullRequestReviewCommentEvent,
  PullRequestReviewEvent: formatPullRequestReviewEvent,
  ReleaseEvent: formatReleaseEvent,
};

function parseEnvList(value) {
  return new Set(
    (value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function getExcludedRepos() {
  const combined = [process.env.EXCLUDED_REPOS, process.env.EXCLUDED_REPO]
    .filter(Boolean)
    .join(",");

  return parseEnvList(combined);
}

function readHistory(historyFile) {
  if (!fs.existsSync(historyFile)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildHistoryItem(event) {
  const formatter = FORMATTERS[event.type];
  const line = formatter ? formatter(event) : null;

  if (!line || !event.repo?.name || !event.created_at) {
    return null;
  }

  return {
    id:
      event.id ||
      `${event.type}:${event.created_at}:${event.repo.name}:${event.payload?.action || ""}`,
    type: event.type,
    repoName: event.repo.name,
    createdAt: event.created_at,
    line,
  };
}

function normalizeHistoryItem(item) {
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.type !== "string" ||
    typeof item.repoName !== "string" ||
    typeof item.createdAt !== "string" ||
    typeof item.line !== "string"
  ) {
    return null;
  }

  if (Number.isNaN(Date.parse(item.createdAt))) {
    return null;
  }

  return item;
}

function mergeHistoryItems(historyItems, newItems, options) {
  const { cutoffTime, eventTypes, excludedRepos } = options;
  const merged = new Map();

  for (const item of [...historyItems, ...newItems]) {
    const normalizedItem = normalizeHistoryItem(item);

    if (!normalizedItem) {
      continue;
    }

    if (eventTypes.size && !eventTypes.has(normalizedItem.type)) {
      continue;
    }

    if (excludedRepos.has(normalizedItem.repoName.toLowerCase())) {
      continue;
    }

    if (Date.parse(normalizedItem.createdAt) < cutoffTime) {
      continue;
    }

    merged.set(normalizedItem.id, normalizedItem);
  }

  return [...merged.values()].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
}

function replaceActivitySection(readme, lines) {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);

  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Couldn't find both activity markers in README. Expected ${START_MARKER} and ${END_MARKER}.`,
    );
  }

  const before = readme.slice(0, start + START_MARKER.length);
  const after = readme.slice(end);
  const content = lines.map((line, index) => `${index + 1}. ${line}`).join("\n");

  return `${before}\n${content}\n${after}`;
}

module.exports = async ({ github, context, core }) => {
  const targetFile = process.env.TARGET_FILE || "README.md";
  const historyFile = process.env.HISTORY_FILE || ".github/activity-history.json";
  const historyDays = parsePositiveInt(process.env.HISTORY_DAYS, 365);
  const maxLines = parsePositiveInt(process.env.MAX_LINES, 5);
  const excludedRepos = getExcludedRepos();
  const eventTypes = parseEnvList(process.env.EVENT_TYPES);
  const username = context.repo.owner;
  const cutoffTime = Date.now() - historyDays * 24 * 60 * 60 * 1000;

  core.info(`Loading public activity for ${username}`);

  const events = await github.paginate(github.rest.activity.listPublicEventsForUser, {
    username,
    per_page: 100,
  });

  const newHistoryItems = events
    .filter((event) => {
      if (eventTypes.size && !eventTypes.has(event.type)) {
        return false;
      }

      return !excludedRepos.has(event.repo?.name?.toLowerCase());
    })
    .map(buildHistoryItem)
    .filter(Boolean)
    .slice(0, 300);

  const historyItems = readHistory(historyFile);
  const mergedHistoryItems = mergeHistoryItems(historyItems, newHistoryItems, {
    cutoffTime,
    eventTypes,
    excludedRepos,
  });

  const lines = mergedHistoryItems.slice(0, maxLines).map((item) => item.line);

  if (!lines.length) {
    lines.push("No recent public activity outside the excluded repositories in the past year.");
  }

  const currentReadme = fs.readFileSync(targetFile, "utf8");
  const nextReadme = replaceActivitySection(currentReadme, lines);
  const nextHistory = `${JSON.stringify(mergedHistoryItems, null, 2)}\n`;
  const currentHistory = fs.existsSync(historyFile)
    ? fs.readFileSync(historyFile, "utf8")
    : "";

  if (nextReadme === currentReadme && nextHistory === currentHistory) {
    core.info(`${targetFile} and ${historyFile} are already up to date`);
    return;
  }

  if (nextReadme !== currentReadme) {
    fs.writeFileSync(targetFile, nextReadme);
    core.info(`Updated ${targetFile} with ${lines.length} recent activities`);
  }

  if (nextHistory !== currentHistory) {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.writeFileSync(historyFile, nextHistory);
    core.info(`Archived ${mergedHistoryItems.length} activity entries in ${historyFile}`);
  }
};
