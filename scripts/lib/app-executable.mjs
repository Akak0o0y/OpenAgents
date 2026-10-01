import fs from 'node:fs';
import path from 'node:path';

/** The product's names, newest first: releases before 0.6.0 were called OpenHours. */
export const PRODUCT_NAMES = ['OpenAgents', 'OpenHours'];

/** The app's executable names, newest first. */
export const EXECUTABLE_NAMES = PRODUCT_NAMES.map(name => `${name}.exe`);

/** The executable in an unpacked or installed app folder of any release; a missing one is reported under the current name. */
export function appExecutable(directory) {
  return EXECUTABLE_NAMES.map(name => path.join(directory, name)).find(file => fs.existsSync(file)) ?? path.join(directory, EXECUTABLE_NAMES[0]);
}
