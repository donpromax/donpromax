const fs = require("fs");

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
  const maxLines = Number.parseInt(process.env.MAX_LINES || "5", 10);
  const excludedRepo = (process.env.EXCLUDED_REPO || "").toLowerCase();
  const eventTypes = parseEnvList(process.env.EVENT_TYPES);
  const username = context.repo.owner;

  core.info(`Loading public activity for ${username}`);

  const events = await github.paginate(github.rest.activity.listPublicEventsForUser, {
    username,
    per_page: 100,
  });

  const lines = events
    .filter((event) => {
      if (eventTypes.size && !eventTypes.has(event.type)) {
        return false;
      }

      return event.repo?.name?.toLowerCase() !== excludedRepo;
    })
    .map((event) => {
      const formatter = FORMATTERS[event.type];
      return formatter ? formatter(event) : null;
    })
    .filter(Boolean)
    .slice(0, maxLines);

  if (!lines.length) {
    lines.push("No recent public activity outside this repository.");
  }

  const currentReadme = fs.readFileSync(targetFile, "utf8");
  const nextReadme = replaceActivitySection(currentReadme, lines);

  if (nextReadme === currentReadme) {
    core.info(`${targetFile} is already up to date`);
    return;
  }

  fs.writeFileSync(targetFile, nextReadme);
  core.info(`Updated ${targetFile} with ${lines.length} recent activities`);
};
