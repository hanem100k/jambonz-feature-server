const assert = require('assert');
assert.ok(process.env.JAMBONES_MYSQL_HOST &&
  process.env.JAMBONES_MYSQL_USER &&
  process.env.JAMBONES_MYSQL_PASSWORD &&
  process.env.JAMBONES_MYSQL_DATABASE, 'missing JAMBONES_MYSQL_XXX env vars');
assert.ok(process.env.DRACHTIO_PORT || process.env.DRACHTIO_HOST, 'missing DRACHTIO_PORT env var');
assert.ok(process.env.DRACHTIO_SECRET, 'missing DRACHTIO_SECRET env var');
assert.ok(process.env.JAMBONES_FREESWITCH, 'missing JAMBONES_FREESWITCH env var');
assert.ok(process.env.JAMBONES_REDIS_HOST, 'missing JAMBONES_REDIS_HOST env var');
assert.ok(process.env.JAMBONES_NETWORK_CIDR || process.env.K8S, 'missing JAMBONES_SUBNET env var');

const Srf = require('drachtio-srf');
const srf = new Srf();
const PORT = process.env.HTTP_PORT || 3000;
const opts = {
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;},
  level: process.env.JAMBONES_LOGLEVEL || 'info'
};
const logger = require('pino')(opts);
const {LifeCycleEvents, FS_UUID_SET_NAME} = require('./lib/utils/constants');
const { installSrfLocals, redisClient, sqlClient } = require('./lib/utils/install-srf-locals');
const { systemHealth } = require('./lib/utils/system-health')
installSrfLocals(srf, logger);


const {
  initLocals,
  getAccountDetails,
  normalizeNumbers,
  retrieveApplication,
  invokeWebCallback
} = require('./lib/middleware')(srf, logger);

// HTTP
const express = require('express');
const helmet = require('helmet');
const app = express();
Object.assign(app.locals, {
  logger,
  srf
});

const httpRoutes = require('./lib/http-routes');
let srfHealthy = true
const InboundCallSession = require('./lib/session/inbound-call-session');

if (process.env.DRACHTIO_HOST) {
  srf.connect({host: process.env.DRACHTIO_HOST, port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET });
  srf.on('connect', (err, hp) => {
    const arr = /^(.*)\/(.*)$/.exec(hp.split(',').pop());
    srf.locals.localSipAddress = `${arr[2]}`;
    logger.info(`connected to drachtio listening on ${hp}, local sip address is ${srf.locals.localSipAddress}`);
  });
}
else {
  logger.info(`listening for drachtio requests on port ${process.env.DRACHTIO_PORT}`);
  srf.listen({port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET});
}

  srf.on('error', (err) => {
    srfHealthy = false
    logger.info(err, 'Error connecting to drachtio');
  });


srf.use('invite', [
  initLocals,
  getAccountDetails,
  normalizeNumbers,
  retrieveApplication,
  invokeWebCallback
]);

srf.invite((req, res) => {
  const session = new InboundCallSession(req, res);
  session.exec();
});

// HTTP
app.use(helmet());
app.use(helmet.hidePoweredBy());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/', httpRoutes);
app.use((err, req, res, next) => {
  logger.error(err, 'burped error');
  res.status(err.status || 500).json({msg: err.message});
});
const httpServer = app.listen(PORT);

logger.info(`listening for HTTP requests on port ${PORT}, serviceUrl is ${srf.locals.serviceUrl}`);

const sessionTracker = srf.locals.sessionTracker = require('./lib/session/session-tracker');
sessionTracker.on('idle', () => {
  if (srf.locals.lifecycleEmitter.operationalState === LifeCycleEvents.ScaleIn) {
    logger.info('scale-in complete now that calls have dried up');
    srf.locals.lifecycleEmitter.scaleIn();
  }
});

const getCount = () => sessionTracker.count;
const healthCheck = require('@jambonz/http-health-check');

healthCheck({app, logger, path: '/system-health', fn: systemHealth(redisClient, sqlClient.promise(), sessionTracker.count, srfHealthy)});
healthCheck({app, logger, path: '/', fn: getCount});

setInterval(() => {
  srf.locals.stats.gauge('fs.sip.calls.count', sessionTracker.count);
}, 5000);

const disconnect = () => {
  return new Promise ((resolve) => {
    httpServer.on('close', resolve);
    httpServer.close();
    srf.disconnect();
    srf.locals.mediaservers.forEach((ms) => ms.disconnect());
  });
};

process.on('SIGUSR2', handle);
process.on('SIGTERM', handle);

function handle(signal) {
  const {removeFromSet} = srf.locals.dbHelpers;
  const setName = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-fs`;
  logger.info(`got signal ${signal}, removing ${srf.locals.localSipAddress} from set ${setName}`);
  removeFromSet(setName, srf.locals.localSipAddress);
  removeFromSet(FS_UUID_SET_NAME, srf.locals.fsUUID);
  srf.locals.disabled = true;
}

if (process.env.JAMBONZ_CLEANUP_INTERVAL_MINS) {
  const {clearFiles} = require('./lib/utils/cron-jobs');

  /* cleanup orphaned files or channels every so often */
  setInterval(async() => {
    try {
      await clearFiles();
    } catch (err) {
      logger.error({err}, 'app.js: error clearing files');
    }
  }, 1000 * 60 * (process.env.JAMBONZ_CLEANUP_INTERVAL_MINS || 60));
}

module.exports = {srf, logger, disconnect};
