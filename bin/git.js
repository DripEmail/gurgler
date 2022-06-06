const {exec} = require('child_process');

/**
 * @param gitSha
 * @returns {Promise<string>}
 */
const getCommitAuthor = (gitSha) => {
  return new Promise((resolve, reject) => {
    exec(`git show --pretty='%aN' --no-patch ${gitSha}`, (err, stdout) => {
      if (err) {
        console.error(`exec error: ${err}`);
        reject();
      }
      resolve(stdout.trim());
    })
  })
}

/**
 * @param gitSha
 * @returns {Promise<string>}
 */
const getBranch = (gitSha) => {
  return new Promise((resolve, reject) => {
    exec(`git rev-parse --abbrev-ref ${gitSha}`, (err, stdout) => {
      if (err) {
        console.error(`exec error: ${err}`);
        reject();
      }
      resolve(stdout.trim());
    })
  })
}

/**
 * @param gitSha
 * @returns {Promise<string>}
 */
const getCommitMessage = (gitSha) => {
  return new Promise((resolve, reject) => {
    exec(`git show --pretty='%s' --no-patch ${gitSha}`, (err, stdout) => {
      if (err) {
        console.error(`exec error: ${err}`);
        reject();
      }
      resolve(stdout.trim());
    })
  })
}

/**
 * @param gitSha
 * @returns {Promise<string>}
 */
const getCommitDate = (gitSha) => {
  return new Promise((resolve, reject) => {
    exec(`git show --pretty='%ah' --no-patch ${gitSha}`, (err, stdout, stderr) => {
      if (err) {
        console.error(`exec error: ${err}`);
        reject();
      }

      if (stderr) {
        console.error(`exec error getCommitDate: ${stderr}`);
      }

      resolve(stdout.trim());
    })
  })
}

/**
 *
 * @param gitSha {string}
 * @returns {Promise<Map<string, string>>}
 */
const getGitInfo = async (gitSha) => {
  return await Promise.all(
    [getCommitAuthor(gitSha),
      getBranch(gitSha),
      getCommitMessage(gitSha),
      getCommitDate(gitSha)
    ]).then(values => {
    const gitInfo = new Map();
    const [author, branch, message, date] = values;

    gitInfo.set("gitSha", gitSha);
    gitInfo.set("author", author);
    gitInfo.set("branch", branch);
    gitInfo.set("message", message);
    gitInfo.set("date", date);

    return gitInfo;
  });
}

module.exports = {
  getGitInfo
};
