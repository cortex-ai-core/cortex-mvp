export function validateDevRun(run, repository) {
  if (run.repository?.full_name !== repository || run.event !== 'push' || run.head_branch !== 'dev'
      || run.status !== 'completed' || run.conclusion !== 'success' || run.path !== '.github/workflows/aws.yml'
      || !/^[a-f0-9]{40}$/.test(run.head_sha) || !Number.isSafeInteger(run.id) || run.id <= 0
      || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) {
    throw new Error('Select a successful Dev push run from the AWS release workflow.');
  }
  return { repository, runId: run.id, runAttempt: run.run_attempt, commit: run.head_sha };
}
export async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${path}`, { headers: {
    Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    'X-GitHub-Api-Version': '2022-11-28',
  } });
  if (!response.ok) throw new Error(`GitHub API failed (${response.status}) for ${path.split('?')[0]}`);
  return response;
}
export async function devRun(repository, id) {
  if (!id || id === 'latest') {
    const response = await (await github(`${repository}/actions/workflows/aws.yml/runs?branch=dev&event=push&status=success&per_page=1`)).json();
    if (!response.workflow_runs?.length) throw new Error('No successful Dev release exists.');
    return validateDevRun(response.workflow_runs[0], repository);
  }
  if (!/^\d+$/.test(id || '')) throw new Error('Supply a numeric Dev workflow run ID.');
  return validateDevRun(await (await github(`${repository}/actions/runs/${id}`)).json(), repository);
}
export function imageTag(value) {
  if (!/^[a-z0-9][a-z0-9_.-]{6,100}$/.test(value || '')) throw new Error('Invalid immutable image tag.');
  return value;
}

export function validateWebArtifact(artifact) {
  if (!artifact || artifact.name !== 'static-web' || artifact.expired || !Number.isSafeInteger(artifact.id)
      || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '')) throw new Error('A retained frontend artifact with a SHA-256 digest is required.');
  return artifact;
}
