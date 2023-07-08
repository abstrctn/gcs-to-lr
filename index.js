const functions = require('@google-cloud/functions-framework');
const crypto = require("crypto");
const path = require("path");
const {Storage} = require('@google-cloud/storage');
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
  getExifFromReadStream,
} = require('./helpers.js');

const {
  createAsset,
  createAssetOriginal,
} = require('./api.js');

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
          ftp_upload_started: new Date(eventData.metadata?.gcsfuse_mtime),
        }
      }]);
    }
    return callback();
  }

  // Preemptively being reading the incoming file data twice: once for the full contents,
  // and a second time reading just enough to grab exif metadata (assumes it's stored at head of file)
  const readStream = file.createReadStream();
  const xmpReadStream = file.createReadStream({start: 0, end: 128 * 1024});  

  let secrets = await getSecrets(['ADOBE_ACCESS_TOKEN', 'ADOBE_REFRESH_TOKEN', 'ADOBE_API_KEY']);

  // Refresh access token if expired
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

  await createAsset({
    body: request_body,
    api_key: secrets.ADOBE_API_KEY,
    access_token: secrets.ADOBE_ACCESS_TOKEN,
    params: {
      catalog_id: process.env.ADOBE_CATALOG_ID,
      uuid,
    }
  });

  await createAssetOriginal({
    // (hacky) overload body as a config object to support piping streams
    body: {
      stream: readStream,
      length: eventData.size,
    },
    api_key: secrets.ADOBE_API_KEY,
    access_token: secrets.ADOBE_ACCESS_TOKEN,
    params: {
      catalog_id: process.env.ADOBE_CATALOG_ID,
      uuid,
    },
  });

  const exif = await getExifFromReadStream(xmpReadStream);

  // Update asset metadata in datastore
  datastore.get(datastore.key(['asset', file_path]), async (err, entity) => {
    console.log({err, entity})
    await writeToDatastore([{
      kind: 'asset',
      name: file_path,
      excludeFromIndexes: [
        'thumbnail',
      ],
      data: {
        asset_id: uuid,
        name: file_name,
        camera_make: exif.Make?.description,
        camera_model: exif.Model?.description,
        camera_serial: exif.BodySerialNumber?.description,
        asset_created: new Date(exif.DateTime?.description.replace(':', '-').replace(':', '-') + getTzOffset()),
        thumbnail: exif.Thumbnail?.image ? Buffer.from(exif.Thumbnail?.image).toString("base64") : null,
        ftp_upload_started: entity?.ftp_upload_started,
        ftp_upload_finished: new Date(eventData.metadata?.gcsfuse_mtime),
      }
    }]);
    callback();
  });
}