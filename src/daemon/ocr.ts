import { createWorker, OEM } from 'tesseract.js';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Bundled English/Arabic language data; OCR never downloads language files. */
export async function createOcr() {
  const require=createRequire(import.meta.url);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'oh-ocr-'));
  try {
    for(const language of ['eng','ara']){
      const location=require(`@tesseract.js-data/${language}`) as {langPath:string};
      await fs.copyFile(path.join(location.langPath,`${language}.traineddata.gz`),path.join(root,`${language}.traineddata.gz`));
    }
    const worker=await createWorker('eng+ara',OEM.LSTM_ONLY,{langPath:root,cacheMethod:'none',gzip:true,
      workerPath:require.resolve('tesseract.js/src/worker-script/node/index.js'),errorHandler:()=>undefined});
    return {
      async read(bytes:Buffer){const result=await worker.recognize(bytes);return {text:result.data.text,confidence:result.data.confidence};},
      async close(){await worker.terminate();await fs.rm(root,{recursive:true,force:true});}
    };
  }catch(error){await fs.rm(root,{recursive:true,force:true});throw error;}
}
