import * as core from "@actions/core";
import * as github from "@actions/github";

type Client = ReturnType<typeof github.getOctokit>;

const ctx = github.context;
const {owner, repo} = ctx.repo;

const header = "⏱ Workflow Timer ⏱";

async function run(): Promise<void> {
    // Original inspiration: https://github.com/DeviesDevelopment/workflow-timer/blob/master/action.yml

    try {
        if (ctx.eventName != "pull_request") {
            console.log(
                "This workflow only runs on pull requests. Skipping...",
            );
            return;
        }

        const token = core.getInput("token");
        const client = github.getOctokit(token);

        const current = await currentRun(client);

        const prev = await defaultBranchRunTime(client, current.workflowId);
        if (!prev) {
            console.log("No recent runs to compare against. Skipping...");
            return;
        }
        const {previousRun, branch} = prev;

        const difference = current.duration - previousRun;
        const percentDifference = (difference * 100) / previousRun;
        const {change, emoji} = getSeverity(percentDifference);
        const p = Math.abs(percentDifference).toFixed(2);

        // prettier-ignore
        const content = `
## ${header}

${emoji} The run time for ["${ctx.workflow}"](${current.url}) has ${change} by ${formatDuration(difference)} (${p}%) ${emoji}

The current run time is ${formatDuration(current.duration)} while \`${branch}\` took ${formatDuration(previousRun)}.
        `;

        await postTimings(client, content);
    } catch (error) {
        if (error instanceof Error) core.setFailed(error.message);
    }
}

async function postTimings(client: Client, body: string) {
    const comments = await client.rest.issues.listComments({
        owner,
        repo,
        issue_number: ctx.issue.number,
    });

    const previousTimings = comments.data.find(comment =>
        comment.body?.includes(header),
    );

    if (previousTimings) {
        await client.rest.issues.updateComment({
            owner,
            repo,
            comment_id: previousTimings.id,
            body,
        });
    } else {
        await client.rest.issues.createComment({
            issue_number: ctx.issue.number,
            owner,
            repo,
            body,
        });
    }
}

function getSeverity(percentage: number): {change: string; emoji: string} {
    if (percentage > 50) {
        return {
            change: "**regressed severely**",
            emoji: "😭",
        };
    } else if (percentage > 20) {
        return {
            change: "regressed a bit",
            emoji: "😥",
        };
    } else if (percentage > 0) {
        return {
            change: "regressed slightly",
            emoji: "🙁",
        };
    } else if (percentage > -20) {
        return {
            change: "improved slightly",
            emoji: "🙂",
        };
    } else if (percentage > -50) {
        return {
            change: "improved a lot",
            emoji: "🥳",
        };
    } else {
        return {
            change: "**improved significantly**",
            emoji: "🤯",
        };
    }
}

function formatDuration(totalSeconds: number): string {
    totalSeconds = Math.abs(totalSeconds);
    const minutes = Math.floor(totalSeconds / 60);
    const secs = Math.trunc(totalSeconds - minutes * 60);

    if (minutes == 1) {
        return `${minutes}min ${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}mins ${secs}s`;
    } else {
        return `${secs}s`;
    }
}

type CurrentRun = {
    duration: number;
    workflowId: number;
    url: string;
};

async function currentRun(client: Client): Promise<CurrentRun> {
    const currentRun = await client.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: ctx.runId,
    });
    const {run_started_at, workflow_id} = currentRun.data;
    if (!run_started_at) {
        throw new Error("Unable to determine when the current run started");
    }

    const durationMs =
        new Date().getTime() - new Date(run_started_at).getTime();

    return {
        duration: durationMs / 1000,
        workflowId: workflow_id,
        url: currentRun.data.html_url,
    };
}

async function defaultBranchRunTime(
    client: Client,
    workflow: number,
): Promise<{previousRun: number; branch: string} | undefined> {
    const {
        data: {default_branch},
    } = await client.rest.repos.get(ctx.repo);

    const historicalRuns = await client.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflow,
    });

    const successfulRuns = historicalRuns.data.workflow_runs.filter(
        run =>
            run.head_branch == default_branch &&
            run.status == "completed" &&
            run.conclusion == "success",
    );

    const latestRun = successfulRuns.shift();
    if (!latestRun || !latestRun.run_started_at) {
        return;
    }

    const lastUpdated = new Date(latestRun.updated_at).getTime();
    const started = new Date(latestRun.run_started_at).getTime();
    return {
        previousRun: (lastUpdated - started) / 1000,
        branch: default_branch,
    };
}

run();
