import log from 'loglevel';

log.setLevel('info');

if (process.env.NODE_ENV !== 'production') {
  log.setLevel('debug');
}

export default log;
