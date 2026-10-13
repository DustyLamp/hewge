import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  AmplifyClient,
  CreateDeploymentCommand,
  StartDeploymentCommand,
  GetJobCommand,
} from "@aws-sdk/client-amplify";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
const region = "eu-north-1";
if (process.env.AWS_PROFILE !== "hewge")
  throw Error("Deploy with AWS_PROFILE=hewge.");
const cfn = new CloudFormationClient({ region });
const result = await cfn.send(
  new DescribeStacksCommand({ StackName: "hewge-production" }),
);
const outputs = Object.fromEntries(
  result.Stacks[0].Outputs.map((o) => [o.OutputKey, o.OutputValue]),
);
if (result.Stacks[0].StackId.split(":")[4] !== "082229154968")
  throw Error("Unexpected AWS account; publication stopped.");
await writeFile(
  "dist/config.json",
  JSON.stringify({
    apiUrl: outputs.ApiUrl,
    userPoolId: outputs.UserPoolId,
    clientId: outputs.UserPoolClientId,
    region,
  }),
);
await mkdir("output", { recursive: true });
const archive = resolve("output/hewge-web.zip");
// Replace the archive completely so removed files never survive a new deployment.
const { rm } = await import("node:fs/promises");
await rm(archive, { force: true });
execFileSync("zip", ["-qr", archive, "."], { cwd: "dist" });
const amplify = new AmplifyClient({ region });
const deployment = await amplify.send(
  new CreateDeploymentCommand({
    appId: outputs.AmplifyAppId,
    branchName: "main",
  }),
);
await writeFile(
  "output/latest-deployment.json",
  JSON.stringify({
    appId: outputs.AmplifyAppId,
    jobId: deployment.jobId,
    url: outputs.DefaultUrl,
  }),
);
const uploaded = await fetch(deployment.zipUploadUrl, {
  method: "PUT",
  body: await readFile(archive),
  headers: { "Content-Type": "application/zip" },
});
if (!uploaded.ok) throw Error(`Upload failed (${uploaded.status})`);
await amplify.send(
  new StartDeploymentCommand({
    appId: outputs.AmplifyAppId,
    branchName: "main",
    jobId: deployment.jobId,
  }),
);
for (let i = 0; i < 90; i++) {
  const result = await amplify.send(
    new GetJobCommand({
      appId: outputs.AmplifyAppId,
      branchName: "main",
      jobId: deployment.jobId,
    }),
  );
  const status = result.job.summary.status;
  console.log(`Deployment ${deployment.jobId}: ${status}`);
  if (status === "SUCCEED") {
    console.log(`Live: ${outputs.DefaultUrl}`);
    process.exit(0);
  }
  if (["FAILED", "CANCELLED"].includes(status))
    throw Error(`Deployment ${status}`);
  await new Promise((r) => setTimeout(r, 10000));
}
throw Error(
  "Deployment still running. Resume the job in output/latest-deployment.json; do not start another deployment.",
);
