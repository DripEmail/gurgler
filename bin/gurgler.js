#! /usr/bin/env node

import {configureCmd, deployCmd, releaseCmd, cleanupCmd} from "./v2.mjs";
import _ from "lodash";
import AWS from 'aws-sdk';
import {join} from "path";
import {readFileSync} from "fs";
import {Command} from "commander";


const program = new Command();


/**
 * *******************
 * Get the config values and verify them and do a little setup work.
 * *******************
 */


const packagePath = join(process.env.PWD, "package.json");
let rawPackageData = readFileSync(packagePath);
let packageData = JSON.parse(rawPackageData);

// TODO There"s got to be a better way to get the path for this.
const gurglerPath = join(process.env.PWD, "gurgler.json")

const packageName = packageData["name"];
const gurglerConfig = packageData["gurgler"];
const environments = gurglerConfig["environments"];
const bucketNames = gurglerConfig["bucketNames"];
const lambdaFunctions = gurglerConfig["lambdaFunctions"];
const bucketPath = gurglerConfig["bucketPath"];
const bucketRegion = gurglerConfig["bucketRegion"];
const globs = gurglerConfig["localFileGlobs"];
const slackWebHookUrl = gurglerConfig["slackWebHookUrl"];
const slackUsername = gurglerConfig["slackUsername"];
const slackIconEmoji = gurglerConfig["slackIconEmoji"];
const githubRepoUrl = gurglerConfig["githubRepoUrl"];

let slackConfig;

if (_.isEmpty(packageName)) {
  console.error("The package name is not set.");
  process.exit(1);
}

if (_.isEmpty(bucketNames)) {
  console.error("The config value bucketNames is not set.");
  process.exit(1);
}

if (_.isEmpty(lambdaFunctions)) {
  console.error("The config value lambdaFunctions is not set.");
  process.exit(1);
}

if (_.isEmpty(bucketPath)) {
  console.error("The config value bucketPath is not set.");
  process.exit(1);
}

if (_.isEmpty(bucketRegion)) {
  console.error("The config value bucketRegion is not set.");
  process.exit(1);
}

// If at least one slack-related key is present in the gurgler config it is assumed Slack should be
// used and all Slack config values are inspected. The omission of all slack-related keys rather
// obviously indicates Slack is not intended to be used, and we don"t need to inspect each key.
if (_.has(gurglerConfig, "slackWebHookUrl") || _.has(gurglerConfig, "slackUsername") || _.has(gurglerConfig, "slackIconEmoji")) {

  if (_.isEmpty(slackWebHookUrl)) {
    console.error("The config value slackWebHookUrl is not set.");
    process.exit(1);
  }

  if (_.isEmpty(slackUsername)) {
    console.error("The config value slackUsername is not set.");
    process.exit(1);
  }

  if (_.isEmpty(slackIconEmoji)) {
    console.error("The config value slackIconEmoji is not set.");
    process.exit(1);
  }

  if (_.isEmpty(githubRepoUrl)) {
    console.error("The config value githubRepoUrl is not set.");
    process.exit(1);
  }

  slackConfig = {
    slackWebHookUrl,
    slackUsername,
    slackIconEmoji,
    githubRepoUrl,
  }
}

AWS.config.update({
  region: bucketRegion
});

/**
 * *****************
 * The "main" part of the program.
 * *****************
 */


const validateGlobs = () => {
  if (!_.has(gurglerConfig, "localFileGlobs")) {
    console.error("The config value localFileGlobs is not set.");
    process.exit(1);
  }
  if (!_.isArray(globs)) {
    console.error("The config value localFileGlobs is not an array.");
    process.exit(1);
  }
  if (_.isEmpty(globs)) {
    console.error("The config value localFileGlobs is empty.");
    process.exit(1);
  }

  globs.forEach(glob => {
    if (!_.has(glob, "pattern")) {
      console.error("At least one glob pattern is not set in the config value localFileGlobs.");
      process.exit(1);
    }
    if (!_.isString(glob.pattern)) {
      console.error("At least one glob pattern is not a string in the config value localFileGlobs.");
      process.exit(1);
    }
    if (_.isEmpty(glob.pattern)) {
      console.error("At least one glob pattern is empty in the config value localFileGlobs.");
      process.exit(1);
    }

    if (!_.has(glob, "ignore")) {
      return;
    }

    if (!_.isArray(glob.ignore)) {
      console.error("At least one glob ignore value is not an array.");
      process.exit(1);
    }

    glob.ignore.forEach(pattern => {
      if (!_.isString(pattern)) {
        console.error("At least one glob ignore pattern is not a string in the config value localFileGlobs.");
        process.exit(1);
      }
      if (_.isEmpty(pattern)) {
        console.error("At least one glob ignore pattern is empty in the config value localFileGlobs.");
        process.exit(1);
      }
    });
  })
}

program
  .command("configure <gitCommitSha> <gitBranch>")
  .description("configures a gurgler.json in the project root to be referenced in the build and deploy process")
  .action((commit, branch) => {
    validateGlobs();
    configureCmd(
      gurglerPath,
      bucketPath,
      commit,
      branch
    );
  });

program
  .command("deploy [gitCommitSha] [gitBranch]")
  .description("sends all assets to S3 (at a particular commit on a particular branch) appending the file's checksum to each filename")
  .option("-p --pretend", "Do not actually send the files")
  .action((gitCommitSha, gitBranch, options) => {
      validateGlobs();
      deployCmd(
        bucketNames,
        gurglerPath,
        globs,
        options.pretend
      )
  });

program
  .command("release")
  .description("takes a previously deployed version and turns it on for a particular environment")
  .option("-e, --environment <environment>", "environment to deploy to")
  .option("-c, --commit <gitSha>", "the git sha (commit) of the version to deploy")

  .action((cmdObj) => {
    releaseCmd(
      cmdObj,
      bucketNames,
      lambdaFunctions,
      environments,
      bucketPath,
      packageName,
      slackConfig
    )
  });



program
  .command("delete-old-deploys")
  .description("delete artifacts from S3 that are older than 90 days and not being used")

  .action((cmdObj) => {
    cleanupCmd(
      cmdObj,
      bucketNames,
      lambdaFunctions,
      environments,
      bucketPath,
      packageName,
      slackConfig
    )
  });


program.parse(process.argv);
