# Gurgler

Deployment tooling

## Setup and Configuration

To get started with Gurgler you need to install it as a "dev" dependency and add some configuration to your `package.json`.

### Install via npm

```bash
npm install gurgler --save-dev
```

### Install via yarn

```bash
yarn add -d gurgler
```

### Setup a Slack App

How to do this is well [documented on Slack's site](https://api.slack.com/slack-apps). After you go through the process the essential bit is the Slack Webhook url.

### Configuration

Add a `gurgler` key to your `package.json`. It should look something like this:

```json
{
"gurgler": {
    "bucketNames": {
      "production": "production-bucket",
      "development": "development-bucket"
    },
    "bucketPath": "some-stuff",
    "bucketRegion": "us-east-1",
    "environments": [
      {
        "key": "dev",
        "ssmKey": "/dev/asset-checksum",
        "serverEnvironment": "development",
        "label": "Development",
        "slackChannel": "#deployments"
      },
      {
        "key": "production",
        "ssmKey": "/production/asset-checksum",
        "serverEnvironment": "production",
        "label": "Production",
        "slackChannel": "#deployments"
      }
    ],
    "localFilePaths": [
      "./dist/my-asset.js"
    ],
    "slackWebHookUrl": "http://hooks.slack.com/services/Something/Something/Something",
    "slackUsername": "Something",
    "slackIconEmoji": ":something:",
    "githubRepoUrl": "https://github.com/User/repo"
    }
}
```

You will probably need change every value in this config to suit your needs.

## How does it work?

Gurgler depends on the following.

 - You're using S3 buckets to host your frontend assets.
 - It uses AWS Systems Manager parameter store to keep track of the checksum of the current "released" asset.

Gurgler has 2 commands.

### Deploy

Deploy uploads an asset to S3. It also attaches a bit of metadata to the asset including the git sha of the commit at the point at which the asset was built.

```
deploy <gitCommitSha> <gitBranch>  sends a new asset (at a particular commit on a particular branch) to the S3 bucket
```

### Release

Release looks at your list of environments and lets you choose one. Then it looks at the list of your previously deployed assets and lets you choose an asset to release. It does this by changing the value in the SSM parameter store. Finally it posts a message to a Slack channel using a webhook.

The `release` command will ask what environment and what deployed asset to use 

It's up to whatever is consuming these assets to read the parameter store values.

```
Usage: gurgler release [options]

takes a previously deployed asset a turns it on for a particular environment

Options:
  -e, --environment <environment>  environment to deploy to
  -c, --commit <gitSha>            the git sha (commit) of the asset to deploy
  -h, --help                       output usage information
```

### Version 2

There currently exist two deployment options while we phase into complete use of version 2. A version 1 deployment appends a file's checksum to the filename itself, allowing releases of individual files. Version 2 deploys all assets under a single common S3 bucket prefix which is the hash of both the git commit and branch to which those assets pertain. As of version 2.1, releases made under the v2 workflow (as described below) are made possible via a cross-account lambda and not direct access to parameter store.

Version 2 also introduces a few new configuration changes and overall deployment workflow:

* You now have the ability to set an environment to master-only, meaning you'll get a warning and additional confirmation prompt if you attempt to deploy non-master branch assets.

```json
{
  "key": "production",
  "ssmKey": "/production/asset-checksum",
  "serverEnvironment": "production",
  "label": "Production",
  "slackChannel": "#deployments",
  "masterOnly": true,
  "v2": true
}
```

* You must also (temporarily) add the `v2` key to any environment with which you wish to use version 2. This requirement will be removed once a full cutover to version 2 is made.

* You can (and must) use file globs to describe which directories and/or files you'd like gurgler to deploy.

```json
"localFileGlobs": [
  {
    "pattern": "build/*",
    "ignore": [
      "*/garbage_file.json"
    ]
  }
],
```

* Version 2 introduces a new CLI command `configure`. Use it to build a `gurgler.json` in the project root. Webpack can use this file as shown in the following example to know how to build internal references to other files in the build directory.

```
gurgler configure asdfasdfasdf some_branch
```

Use `gurgler.publicPath` in your webpack config to know what the public path will be once deployed to S3.

```javascript
const gurgler = require("gurgler")

...

{
  loader: "file-loader",
    options: {
      name: "[name].[ext]"
      publicPath: gurgler.publicPath()
    }
}
```

Now you can build your assets and subsequently deploy the with `gurgler deploy --v2`. Note that unlike version 1, no arguments are provided to `deploy`.

To release, simply add the `v2` flag:

```
gurgler release --v2
```

You must run `configure` prior to every build in order to ensure your deploys are versioned under the correct commit and branch. You can easily set up a script to do so.

```javascript
const { execSync } = require("child_process");

const gitCommitSha = process.argv[2];
const gitBranch = process.argv[3];

if (!gitCommitSha) {
  throw new Error("The git commit sha is not set");
}
if (!gitBranch) {
  throw new Error("The git branch is not set");
}

execSync(`yarn configure ${gitCommitSha} ${gitBranch}`, {
  stdio: [0, 1, 2]
});

execSync(`yarn build`, { stdio: [0, 1, 2] });
```

This example assumes your package.json is set up with the following scripts:

*scripts/build.js is the script shown above.*

```json
{
    "scripts": {
        "configure": "gurgler configure",
        "build": "webpack --config webpack.config.js",
        "configure-and-build": "node scripts/build.js",
        "deploy": "gurgler deploy --v2",
        "release": "gurgler release --v2"
  }   
}
```

## Tips

You could use your "continuous integration" system to run the "deploy" command after a successful build.

Using `npx` is a nice way to try out the `gurgler`.

## What does the name mean?

It means ["down the drain"](https://en.wiktionary.org/wiki/down_the_gurgler#English) in Australia and New Zealand.

Because releasing code is kinda like, sending it down the drain into the series of tubes that is, the Interwebs. 
