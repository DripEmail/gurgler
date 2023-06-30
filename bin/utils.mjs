import { ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";

const makeHashDigest = hash => hash.substring(0, 7);

const getContentType = (ext) => {
  let contentType = "application/octet-stream";
  // TODO: Add more content types
  if  (ext === ".css") {
    contentType = "text/css";
  } else if (ext === ".json") {
    contentType = "application/json";
  } else if (ext === ".html") {
    contentType = "text/html";
  } else if (ext === ".js") {
    contentType = "application/javascript";
  } else if (ext === ".svg") {
    contentType = "image/svg+xml";
  } else if (ext === ".woff") {
    contentType = "application/font-woff";
  }
  return contentType;
};

// Delete all the things in a directory on S3.
// Taken from here:
// https://stackoverflow.com/questions/20207063/how-can-i-delete-folder-on-s3-with-node-js
async function emptyS3Directory(s3, bucket, dir) {
  const listParams = {
    Bucket: bucket,
    Prefix: dir
  };

  const command = new ListObjectsV2Command(listParams);
  const listedObjects = await s3.send(command);

  if (listedObjects.Contents.length === 0) return;

  const deleteParams = {
    Bucket: bucket,
    Delete: { Objects: [] }
  };

  listedObjects.Contents.forEach(({ Key }) => {
    deleteParams.Delete.Objects.push({ Key });
  });

  const deleteObjectsCommand = new DeleteObjectsCommand(deleteParams);
  await s3.send(deleteObjectsCommand);

  // If our list of objects was not the "whole" list, call this function again.
  if (listedObjects.IsTruncated) await emptyS3Directory(bucket, dir);
}

export {
  makeHashDigest,
  getContentType,
  emptyS3Directory
};
