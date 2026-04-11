import { dispatch } from './cli/dispatch.js';

dispatch(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
