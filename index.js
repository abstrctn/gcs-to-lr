const functions = require('@google-cloud/functions-framework');
const https = require("https");
const crypto = require("crypto");
const path = require("path");
const {Storage} = require('@google-cloud/storage');
const ExifReader = require('exifreader');
const {Datastore} = require('@google-cloud/datastore');

const {
  tokenExpired,
  parseJwt,
  getSecrets,
  writeToDatastore,
  refreshCredentials,
  getTzOffset,
  getAdobeApiStats,
  getCameraSummaries,
  fetchTokens,
} = require('./helpers.js');

const datastore = new Datastore();

functions.http('statusData', (req, res) => {
  if (req.method === 'OPTIONS') {
    // Send response to OPTIONS requests
    res.set('Access-Control-Allow-Methods', 'GET');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');

  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const apiStatsPromise = getAdobeApiStats();
    const cameraSummariesPromise = getCameraSummaries();

    getSecrets(['ADOBE_ACCESS_TOKEN', 'ADOBE_CLIENT_SECRET', 'ADOBE_REFRESH_TOKEN'])
      .then((secrets) => {
        const access_jwt = parseJwt(secrets.ADOBE_ACCESS_TOKEN),
              refresh_jwt = parseJwt(secrets.ADOBE_REFRESH_TOKEN);
        const access_expires_at = parseInt(access_jwt.created_at) + parseInt(access_jwt.expires_in),
              refresh_expires_at = parseInt(refresh_jwt.created_at) + parseInt(refresh_jwt.expires_in);
        Promise.all([apiStatsPromise, cameraSummariesPromise]).then((results) => {
          const [adobeApiStats, cameraSummaries] = results;

          res.send(JSON.stringify({
            access_expires_in: access_expires_at - new Date().getTime(),
            refresh_expires_in: refresh_expires_at - new Date().getTime(),
            access_expired: tokenExpired(secrets.ADOBE_ACCESS_TOKEN),
            refresh_expired: tokenExpired(secrets.ADOBE_REFRESH_TOKEN),
            adobeApiStats,
            cameraSummaries,
          }));
        })
      });
  }
});

functions.http('status', (req, res) => {
  // Check if code parameter is specified, at which point:
  // * Fetch a refresh token
  if (req.query && req.query.code) {
    fetchTokens(req.query.code).then((id_token) => {
      res.redirect(`https://status.strickles.photos?id_token=${id_token}`);
    });
  } else {
    res.sendFile('/workspace/status.html');
  }
});

exports.index = async (eventData, context, callback) => {
  console.log({eventData})
  const storage = new Storage();

  const bucket = storage.bucket(eventData.bucket);
  const file_path = eventData.name;
  const file = bucket.file(file_path);
  const file_name = path.basename(file_path);

  const uuid = crypto.randomUUID().replaceAll("-", "");
  console.log({uuid});
  const readStream = file.createReadStream();
  const xmpReadStream = file.createReadStream({start: 0, end: 128 * 1024});

  // FTP client touches an empty file before finally uploading
  // the rest of the data.
  if (eventData.size == 0) {
    // finalized events are created for folders too, so scope to only the file create
    if (file_name.indexOf(".") > 0) {
      await writeToDatastore([{
        kind: 'asset',
        name: file_path,
        data: {
          asset_id: uuid,
          name: file_name,
          ftp_upload_started: new Date(eventData.metadata.gcsfuse_mtime),
        }
      }]);
    }
    return callback();
  }

  let secrets = await getSecrets(['ADOBE_ACCESS_TOKEN', 'ADOBE_API_KEY']);

  // Check for expired access token
  if (tokenExpired(secrets.ADOBE_ACCESS_TOKEN)) {
    if (tokenExpired(secrets.ADOBE_REFRESH_TOKEN)) {
      console.log('refresh token expired, bailing.');
      // TODO: Mark as failure
      return callback();
    }
    console.log('token expired, refreshing...')
    secrets.ADOBE_ACCESS_TOKEN = await refreshCredentials(secrets);
    console.log('token refreshed')
  }

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
        'Authorization': `Bearer ${secrets.ADOBE_ACCESS_TOKEN}`,
        'X-Api-Key': secrets.ADOBE_API_KEY,
        'Content-Length': request_body.length,
        'Content-Type': 'application/json'
      }
    },
    async function(response) {
      console.log("res1", response.statusCode, response.headers)
      let responseData = '';
      response.on('data', (chunk) => {
        responseData += chunk;
      });
      response.on('end', () => {
        writeToDatastore([{
          kind: 'api-call',
          data: {
            endpoint: 'createAsset',
            catalog: process.env.ADOBE_CATALOG_ID,
            asset_id: uuid,
            responseStatus: response.statusCode,
            responseBody: responseData,
          }
        }]);
        console.log({responseData});
      })
      const req_upload = https.request(
        {
          protocol: 'https:',
          hostname: 'lr.adobe.io',
          port: 443,
          path: `/v2/catalogs/${process.env.ADOBE_CATALOG_ID}/assets/${uuid}/master`,
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${secrets.ADOBE_ACCESS_TOKEN}`,
            'X-Api-Key': secrets.ADOBE_API_KEY,
            'Content-Type': 'application/octet-stream',
            'Content-Length': eventData.size
          }
        },
        (response) => {
          console.log('res2', response.statusCode)
          let responseData = '';
          response.on('data', (chunk) => {
            responseData += chunk;
          });
          response.on('end', () => {
            writeToDatastore([{
              kind: 'api-call',
              data: {
                endpoint: 'createAssetOriginal',
                catalog: process.env.ADOBE_CATALOG_ID,
                asset_id: uuid,
                responseStatus: response.statusCode,
                responseBody: responseData,
              }
            }]);
            console.log({responseData});

            let chunks = [];
            xmpReadStream
              .on('data', (chunk) => chunks.push(chunk))
              .on('end', () => {
                datastore.get(datastore.key(['asset', file_path]), async (err, entity) => {
                  console.log({err, entity})
                  const buffer = Buffer.concat(chunks);
                  const exif = ExifReader.load(buffer);
                  await writeToDatastore([{
                    kind: 'asset',
                    name: file_path,
                    excludeFromIndexes: [
                      'thumbnail',
                    ],
                    data: {
                      asset_id: uuid,
                      name: file_name,
                      camera_make: exif.Make.description,
                      camera_model: exif.Model.description,
                      camera_serial: exif.BodySerialNumber?.description,
                      asset_created: new Date(exif.DateTime.description.replace(':', '-').replace(':', '-') + getTzOffset()),
                      thumbnail: Buffer.from(exif.Thumbnail.image).toString("base64"),
                      ftp_upload_started: entity?.ftp_upload_started,
                      ftp_upload_finished: new Date(eventData.metadata.gcsfuse_mtime),
                    }
                  }]);
                  callback();
                });
              });
          });
        }
      );
      console.log('uploading...');
      req_upload.on('error', (e) => {
        console.log('error uploading');
        console.error(e);
      });
      readStream.pipe(req_upload)
        .on('error', (e) => {
          console.log('error piping');
          console.error(e);
        })
        .on('finish', () => {
          console.log('finish upload')
          req_upload.end()
        })
    }
  );
  req_create.write(request_body)
  req_create.end()
}