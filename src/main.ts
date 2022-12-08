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
    /** A free-form message added to the top of the comment. */
    message?: string;
};

type CommentInputs = {
    /** The timings we'll be comparing against */
    defaultBranch?: WorkflowRun;
    /** The timings for the current CI run. */
    currentRun: WorkflowRun;
    /** Timing information for previous runs in the same PR. */
    previousRuns: WorkflowRun[];
    /** The names of each of the jobs we are measuring. */
    jobNames: string[];
    /** A free-form message added to the top of the comment. */
    message?: string;
};

/**
 * Timing information for a particular CI run.
 */
type WorkflowRun = {
    /** The ID for this run of the workflow. */
    runId: number;
    /** The URL for viewing the overall run on GitHub. */
    htmlUrl: string;
    /** A human-friendly string to use when showing this run to the user. */
    displayName: string;
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

type Inputs = {
    token: string;
    message: string;
    jobs: string[];
};

async function run() {
    try {
        const inputs: Inputs = {
            token: core.getInput("token", {required: true}),
            message: core.getInput("message"),
            jobs: core.getMultilineInput("jobs", {required: true}),
        };
        const client = github.getOctokit(inputs.token);

        const pullRequest = ctx.payload.pull_request?.number;

        if (pullRequest == undefined) {
            core.notice(
                "This workflow only runs on pull requests. Skipping...",
            );
            return;
        }

        const config: Config = await loadConfig(client, pullRequest, inputs);

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
): Promise<WorkflowRun | undefined> {
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
        ...timings,
        displayName: branch,
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

    for (const job of allJobs.data.jobs) {
        console.log("Job:", job);
        if (!jobNames.includes(job.name)) {
            continue;
        }

        const {started_at, completed_at, name, html_url, url} = job;
        if (!completed_at) {
            core.warning(
                `Unable to get timings for "${name}" on run ${runId} (${run.data.html_url}) because it hasn't finished yet (${html_url})`,
            );
            continue;
        }

        const milliseconds =
            new Date(completed_at).getTime() - new Date(started_at).getTime();

        const jobTimings = {
            name,
            url: html_url || url,
            duration: Math.round(milliseconds / 1000),
        };
        console.log(jobTimings);
        jobs.push(jobTimings);
    }

    if (jobs.length == 0) {
        const names = allJobs.data.jobs.map(j => `"${j.name}"`).join(", ");
        core.warning(
            `No jobs selected for run ${runId} (${run.data.html_url}). Available jobs: ${names}`,
        );
    }

    return {
        runId,
        displayName: run.data.head_sha.substring(0, 7),
        htmlUrl: run.data.html_url,
        jobs,
        started: run.data.created_at,
    };
}

async function loadConfig(
    client: Client,
    pullRequest: number,
    inputs: Inputs,
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

    return {
        currentRunId,
        message: inputs.message,
        defaultBranch,
        workflowId,
        jobsToMonitor: inputs.jobs,
        pullRequest,
    };
}

function formatComment(comment: CommentInputs): string {
    const {currentRun, jobNames, defaultBranch} = comment;

    const lines: string[] = [header];
    lines.push("");

    if (comment.message) {
        lines.push(comment.message);
        lines.push("");
    }

    const tableHeader = ["Run", ...jobNames];
    lines.push("| " + tableHeader.join(" | ") + " |");
    lines.push("| " + tableHeader.map(() => "---").join(" | ") + " |");

    if (defaultBranch) {
        lines.push(commentRow(defaultBranch, jobNames));
    }

    lines.push(commentRow(currentRun, jobNames));

    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(
        `🤖 *Beep. Boop. I'm a bot. If you find any issues, please report them to <${packageJson.homepage}>.*`,
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
        name = run.displayName;
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
