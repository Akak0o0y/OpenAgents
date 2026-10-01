// Offline: only explicitly named sanitized JSONL input. No providers, profile or network.
import fs from 'node:fs';
import {combinedModelsReport} from '../dist/src/evals/combined-models-report.js';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw new Error('Usage: node scripts/combined-models-report.mjs sanitized-runs.jsonl report.json');
if(fs.statSync(input).size>64*1024*1024)throw new Error('Input limit: 64 MiB. Split experiments.');
const rows=fs.readFileSync(input,'utf8').split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));
fs.writeFileSync(output,JSON.stringify(combinedModelsReport(rows),null,2)+'\n',{flag:'wx'});
console.log('Research report written. No production qualification granted.');
