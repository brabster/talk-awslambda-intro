'use strict';

/**
This Lambda computes a total number of response bytes from a publicly-available NASA webserver access log dataset. It uses AWS S3 listObjects operation, which returns pages of results, to break the larger task down into batches. Each batch is processed to determine a byte count, which is then added to a running total. The Lambda then invokes itself asynchronously with an event containing the pagination token and the running total. This process repeats until a maxPages limit is reached or there are no more pages to process.

The dataset can be downloaded from http://ita.ee.lbl.gov/html/contrib/NASA-HTTP.html. There's two, each around 20Mb compressed, 170Mb decompressed. You can use either or both.

Download the data set you want to work with, then decompress it. Split the large file into a large number of smaller files (eg. split -l 1000 dataset.txt on a Linux machine) and upload them to an S3 bucket (aws s3 sync my/files s3://my-bucket)

Upload the Lambda. Give it permissions to list objects and read objects in your bucket, to write to cloudwatch logs, and to invoke itself. Trigger it using the test button and it will process the files to produce a byte count.
**/

const AWS = require('aws-sdk');

const maxPages = 100;

const s3bucket = new AWS.S3({
          region: "your-region",
          params: {
              Bucket: 'your-bucket-name'
          }
      }),
      lambda = new AWS.Lambda({region: "eu-west-1"}),
      sum = (a, b) => a + b,
      sumResponseBytes = (logBuffer) => {
          return logBuffer.toString('utf8').split('\n')
          .map((line) => line.split(' ').pop())
          .map(parseInt)
          .filter((bytes) => !isNaN(bytes))
          .reduce(sum);
      },
      listBucketResult2responseByteCount = (result) => result
        .Contents
        .map((result) => result.Key)
        .map((key) => new Promise((resolve, reject) => {
            s3bucket.getObject({Key: key}, (err, data) => {
                if (err) {
                    reject(err);
                }
                resolve(sumResponseBytes(data.Body));
            })})),
      completionReport = (evt) => ["Found", (Math.round(evt.TotalBytes/1024/1024)), "MBs in", evt.PagesProcessed, "pages of log objects"].join(" ");

/**
 * Lambda handler function
 * 
 * Sums the bytes in a page of access log data and invokes itself again
 **/
exports.handler = (event, context) => {
    
    /**
     * example event = {
     *   "TotalBytes": 379830440,
     *   "PagesProcessed": 1,
     *   "NextContinuationToken": "1L2JB9WU5RCW6BpSEBqROiJygf5NMqTNszz5Hu5WQZaiqJzYXZrAG9A=="
     * }
     **/

    // are we done?
    if (event.PagesProcessed == maxPages) {
        console.log("Max pages reached", completionReport(event));
        return context.succeed("Processed max pages");
    } else if (event.TotalBytes && !event.NextContinuationToken) {
        console.log("All pages finished", completionReport(event));
        return context.succeed("Processed all pages");
    }

    // we're not done, get the response byte count for the next page of keys and recurse
    s3bucket.listObjectsV2({MaxKeys: 10}, (err, data) => {
        if (err) {
            return context.fail(err);
        }
        
        Promise.all(listBucketResult2responseByteCount(data))
        .then((byteCounts) => byteCounts.reduce(sum))
        .then((totalBytes) => ({
            TotalBytes: (event.TotalBytes || 0) + totalBytes,
            PagesProcessed: (event.PagesProcessed || 0) + 1,
            NextContinuationToken: data.NextContinuationToken}))
        .then((arg) => {
            console.log("invoking again with", JSON.stringify(arg));
            return lambda.invokeAsync({FunctionName: context.invokedFunctionArn.split(":").pop(), InvokeArgs: JSON.stringify(arg)}, (err, data) => {
                if (err) {
                    return context.fail(err);
                }
                context.succeed(data);
            });
        });
    });
};
