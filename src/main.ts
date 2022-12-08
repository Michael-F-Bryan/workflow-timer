import * as core from "@actions/core";
import * as github from "@actions/github";
import packageJson from "../package.json";

type Client = ReturnType<typeof github.getOctokit>;

const ctx = github.context;
const {owner, repo} = ctx.repo;

const header = "⏱ Workflow Timer ⏱";

type Config = {
    /**
     * The name of the branch we are comparing this workflow against.
     */
    defaultBranch: string;
    /** The current pull request's number. This is used so we can see the
     * timings for all other workflow runs in a particular PR.
     */
    pullRequest: number;
    /**
     * The ID for the workflow being checked (e.g. ".github/workflows/ci.yml").
     */
    workflowId: number;
    /** The ID for the current run of this workflow. */
    currentRunId: number;
    /**
     * Which jobs do we want to monitor?
     */
    jobsToMonitor: string[];
};

type CommentInputs = {
    /** The timings we'll be comparing against */
    defaultBranch?: WorkflowRun & {branchName: string};
    /** The timings for the current CI run. */
    currentRun: WorkflowRun;
    /** Timing information for previous runs in the same PR. */
    previousRuns: WorkflowRun[];
    /** The names of each of the jobs we are measuring. */
    jobNames: string[];
};

/**
 * Timing information for a particular CI run.
 */
type WorkflowRun = {
    /** The ID for this run of the workflow. */
    runId: number;
    /** The URL for viewing the overall run on GitHub. */
    htmlUrl: string;
    /** The commit the workflow corresponds to. */
    commitHash: string;
    /** Timings for each of the jobs in the workflow. */
    jobs: JobTimes[];
    /** When the run was started. */
    started: string;
};

type JobTimes = {
    name: string;
    /** A URL to view the  */
    url: string;
    duration: number;
};

async function run() {
    try {
        const token = core.getInput("token", {required: true});
        const client = github.getOctokit(token);

        const pullRequest = ctx.payload.pull_request?.number;

        if (pullRequest == undefined) {
            core.notice(
                "This workflow only runs on pull requests. Skipping...",
            );
            return;
        }

        const config: Config = await loadConfig(client, pullRequest);

        console.log("Loaded configuration", config);

        const timings: CommentInputs = await calculateAllTimings(
            client,
            config,
        );
        const body = formatComment(timings);
        await postTimings(client, body);
    } catch (error) {
        console.error(error);

        if (error instanceof Error) {
            core.setFailed(error.message);
        } else if (typeof error == "string") {
            core.setFailed(error);
        } else {
            core.setFailed("An unknown error has occurred");
        }
    }
}

async function calculateAllTimings(
    client: Client,
    config: Config,
): Promise<CommentInputs> {
    console.log("Calculating timings...");

    const currentRun = await getTimings(
        client,
        config.currentRunId,
        config.jobsToMonitor,
    );
    console.log("Current timings", JSON.stringify(currentRun, null, 2));

    const defaultBranch = await getDefaultBranchTimings(
        client,
        config.defaultBranch,
        config.workflowId,
        config.jobsToMonitor,
    );

    const previousRuns = await getPreviousRunTimings(
        client,
        config.pullRequest,
        config.workflowId,
        config.jobsToMonitor,
    );

    return {
        currentRun,
        defaultBranch,
        previousRuns,
        jobNames: config.jobsToMonitor,
    };
}

async function getPreviousRunTimings(
    client: Client,
    pr: number,
    workflow: number,
    jobNames: string[],
): Promise<WorkflowRun[]> {
    return [];
}

async function getDefaultBranchTimings(
    client: Client,
    branch: string,
    workflow: number,
    jobNames: string[],
): Promise<(WorkflowRun & {branchName: string}) | undefined> {
    const historicalRuns = await client.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflow,
    });

    const successfulRuns = historicalRuns.data.workflow_runs.filter(
        run =>
            run.head_branch == branch &&
            run.status == "completed" &&
            run.conclusion == "success",
    );

    const latestRun = successfulRuns.shift();
    if (!latestRun || !latestRun.run_started_at) {
        return;
    }

    console.log(
        `Last successful run for the default branch (${branch}) was ${latestRun.id} at ${latestRun.updated_at} (${latestRun.html_url})`,
    );

    const timings = await getTimings(client, latestRun.id, jobNames);
    return {
        branchName: branch,
        ...timings,
    };
}

async function getTimings(
    client: Client,
    runId: number,
    jobNames: string[],
): Promise<WorkflowRun> {
    const run = await client.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
    });
    console.log(`Getting timings for run ${runId} (${run.data.html_url})`);

    const allJobs = await client.rest.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: runId,
    });

    const jobs: JobTimes[] = [];

    for (const job of allJobs.data.jobs.filter(j =>
        jobNames.includes(j.name),
    )) {
        const {started_at, completed_at, name, html_url, url} = job;
        if (!completed_at) {
            core.warning(
                `Unable to get timings for "${name}" on run ${runId} (${run.data.html_url}) because it hasn't finished yet (${html_url})`,
            );
            continue;
        }

        const duration =
            new Date(completed_at).getTime() - new Date(started_at).getTime();

        const jobTimings = {name, url: html_url || url, duration};
        console.log(jobTimings);
        jobs.push(jobTimings);
    }

    return {
        runId,
        commitHash: run.data.head_sha,
        htmlUrl: run.data.html_url,
        jobs,
        started: run.data.created_at,
    };
}

async function loadConfig(
    client: Client,
    pullRequest: number,
): Promise<Config> {
    const {
        data: {default_branch: defaultBranch},
    } = await client.rest.repos.get(ctx.repo);

    const currentRunId = ctx.runId;

    const {
        data: {workflow_id: workflowId},
    } = await client.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: currentRunId,
    });

    const jobsToMonitor = core.getMultilineInput("jobs", {required: true});

    return {
        currentRunId,
        defaultBranch,
        workflowId,
        jobsToMonitor,
        pullRequest,
    };
}

function formatComment(timings: CommentInputs): string {
    const {currentRun, jobNames, defaultBranch} = timings;

    const lines: string[] = [header];
    lines.push("");

    const tableHeader = ["Run", ...jobNames];
    lines.push("| " + tableHeader.join(" | ") + " |");
    lines.push("| " + tableHeader.map(() => "---") + " |");

    if (defaultBranch) {
        lines.push(
            commentRow(defaultBranch, jobNames, defaultBranch.branchName),
        );
    }

    lines.push(commentRow(currentRun, jobNames));

    lines.push("");
    lines.push(
        `<small>🤖 Beep. Boop. I'm a bot. If you find any issues, please report them to <a href="${packageJson.homepage}">${packageJson.homepage}</a>.</small>`,
    );

    return lines.join("\n");
}

function commentRow(
    run: WorkflowRun,
    columns: string[],
    name: string | undefined = undefined,
): string {
    const {htmlUrl, jobs} = run;
    if (!name) {
        name = run.commitHash;
    }

    const label = `[${name}](${htmlUrl})`;
    const row = [label];

    for (const column of columns) {
        const job = jobs.find(j => j.name == column);
        if (job) {
            const url = job.url;
            const duration = formatDuration(job.duration);
            row.push(`[${duration}](${url})`);
        } else {
            row.push("-");
        }
    }

    return "| " + row.join(" | ") + " |";
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

run();
