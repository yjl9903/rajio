import { breadc } from 'breadc';

import { version, description } from '../package.json' with { type: 'json' };

const app = breadc('rajio', { version, description });

app.run(process.argv.slice(2)).catch((error) => {
  console.error(error);
});
