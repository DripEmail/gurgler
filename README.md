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

Deploy uploads an asset to S3. It also attaches a bit of meta data to the asset including the git sha of the commit at the point at which the asset was built.

```
deploy <gitCommitSha> <gitBranch>  sends a new asset (at a particular commit on a particular branch) to the S3 bucket
```

### Release

Release looks at your list of environments and lets you choose one. Then it looks at the list of your previously deployed assets and lets you choose an asset to release. It does my changing the value in the SSM parameter store.

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

## Tips

You could use your "continuous integration" system to run the "deploy" command after a successful build.

Using `npx` is a nice way to try out the `gurgler`.

## What does the name mean?

It means ["down the drain"](https://en.wiktionary.org/wiki/down_the_gurgler#English) in Australia and New Zealand.

Because releasing code is kinda like, sending it down the drain into the series of tubes that is, the Interwebs. 
