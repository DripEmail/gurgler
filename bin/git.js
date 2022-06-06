const {exec} = require('child_process');

/**
 * @param gitSha
 * @returns {Promise<string>}
 */
const getCommitAuthor = (gitSha) => {
  return new Promise((resolve, reject) => {
    exec(`git show --pretty='%aN' ${gitSha}`, (err, stdout) => {
      if (err) {
        console.error(`exec error: ${err}`);
        reject();
      }
      resolve(stdout);
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
      resolve(stdout);
    })
  })
}

/**
 * @param gitSha
 * @returns {Promise<string>}
 */
const getCommitMessage = (gitSha) => {
  return new Promise((resolve, reject) => {
    exec(`git log --pretty='%s' -1 ${gitSha}`, (err, stdout) => {
      if (err) {
        console.error(`exec error: ${err}`);
        reject();
      }
      resolve(stdout);
    })
  })
}

/**
 * @param gitSha
 * @returns {Promise<string>}
 */
const getCommitDate = (gitSha) => {
  return new Promise((resolve, reject) => {
    exec(`git log --pretty='%aD' -1 ${gitSha}`, (err, stdout) => {
      if (err) {
        console.error(`exec error: ${err}`);
        reject();
      }
      resolve(stdout);
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
