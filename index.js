const https = require("https");
const crypto = require("crypto");
const path = require("path");
const {Storage} = require('@google-cloud/storage');

exports.index = (eventData, context, callback) => {
  console.log({eventData})
  const storage = new Storage();

  // FTP client touches an empty file before finally uploading
  // the rest of the data.
  if (eventData.size == 0) { return callback() }
  
  const bucket = storage.bucket(eventData.bucket);
  const file = bucket.file(eventData.name);
  const file_name = path.basename(eventData.name);

  const uuid = crypto.randomUUID().replaceAll("-", "");
  console.log({uuid});
  const readStream = file.createReadStream();

  const request_body = JSON.stringify({
    "subtype": "image",
    "payload": {
      "userCreated": new Date().toISOString(),
      "userUpdated": new Date().toISOString(),
      "captureDate": "0000-00-00T00:00:00",
      "importSource": {
        "fileName": file_name,
        "importedOnDevice": "google-cloud-function-v1",
        "importedBy": process.env.ADOBE_ACCOUNT_ID,
        "importTimestamp": new Date().toISOString()
      }
    }
  });
  console.log({request_body})

  const req_create = https.request(
    {
      protocol: 'https:',
      hostname: 'lr.adobe.io',
      port: 443,
      path: `/v2/catalogs/${process.env.ADOBE_CATALOG_ID}/assets/${uuid}`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${process.env.ADOBE_ACCESS_TOKEN}`,
        'X-Api-Key': process.env.ADOBE_API_KEY,
        'Content-Length': request_body.length,
        'Content-Type': 'application/json'
      }
    },
    async function(response) {
      console.log("res1", response.statusCode, response.headers)
      response.on('data', (chunk) => {
        console.log(chunk.toString())
      })
      const req_upload = https.request(
        {
          protocol: 'https:',
          hostname: 'lr.adobe.io',
          port: 443,
          path: `/v2/catalogs/${process.env.ADOBE_CATALOG_ID}/assets/${uuid}/master`,
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${process.env.ADOBE_ACCESS_TOKEN}`,
            'X-Api-Key': process.env.ADOBE_API_KEY,
            'Content-Type': 'application/octet-stream',
            'Content-Length': eventData.size
          }
        },
        (response) => {
          console.log('res2', response.statusCode)
          response.on('data', (chunk) => {
            console.log(chunk.toString())
          })
          callback();
        }
      );
      req_upload.on('error', (err) => {
        console.log('error2', err)
      })

      readStream.pipe(req_upload)
        .on('finish', () => {
          console.log('finish upload')
          req_upload.end()
        })
    }
  );
  req_create.on('error', (err) => {
    console.log("error", err)
  })
  req_create.write(request_body)
  req_create.end()
}