import { parentPort, workerData } from 'node:worker_threads';
import { officeEntries } from './document-tools.js';
import { imageSize } from 'image-size';
import ExcelJS from 'exceljs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createOcr } from './ocr.js';
import { createCanvas } from '@napi-rs/canvas';

const xmlText = (xml: string) => [...xml.matchAll(/<(?:w|a):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w|a):t>/g)].map(m => m[1]
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&')).join('\n');
try {
  const { name, data } = workerData as { name: string; data: Uint8Array };
  const ext = name.split('.').at(-1)!.toLowerCase();
  let text = '', mime: string | undefined;
  if (['png','jpg','jpeg','webp'].includes(ext)) {
    const size = imageSize(data);
    if (!['png','jpg','webp'].includes(size.type ?? '') || !size.width || !size.height || size.width * size.height > 4_000_000 || size.width > 4096 || size.height > 4096) throw new Error('Images must be PNG, JPEG or WebP, at most 4 megapixels and 4096 pixels per side.');
    mime = size.type === 'jpg' ? 'image/jpeg' : `image/${size.type}`;
    text = `Image: ${name}, ${size.width} × ${size.height}.`;
    if(size.width>=100&&size.height>=40){
      const ocr=await createOcr();try{const result=await ocr.read(Buffer.from(data));if(result.text.trim())text+=`\nOCR (machine transcription, confidence ${Math.round(result.confidence)}%; verify against the image):\n${result.text}`;}finally{await ocr.close();}
    }
  } else if (ext === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfRoot=path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
    // PDF.js's Node factory passes this string directly to fs.readFile;
    // it needs a filesystem path with a forward trailing slash, not a file URL.
    const assetPath=(folder:string)=>path.join(pdfRoot,folder).replaceAll('\\','/')+'/';
    const loading = getDocument({ data: new Uint8Array(data), useSystemFonts: false, disableFontFace: true, stopAtErrors: true,
      standardFontDataUrl:assetPath('standard_fonts'),cMapUrl:assetPath('cmaps'),cMapPacked:true,wasmUrl:assetPath('wasm') });
    let ocr:Awaited<ReturnType<typeof createOcr>>|undefined;
    let ocrPages=0;
    try {
      const doc = await loading.promise;
      for (let i=1;i<=Math.min(doc.numPages,40) && text.length<=64000;i++) {
        const page=await doc.getPage(i);const content=await page.getTextContent();
        const extracted=content.items.map(item=>'str' in item?item.str:'').join(' ');
        text += `\nPage ${i}\n` + extracted;
        if(extracted.trim().length<30){
          if(ocrPages>=10){text+='\n[OCR limit: remaining scanned pages omitted.]';break;}
          const base=page.getViewport({scale:1});const scale=Math.min(2,Math.sqrt(4_000_000/(base.width*base.height)));
          const viewport=page.getViewport({scale});
          if(!Number.isFinite(viewport.width)||viewport.width<=0||viewport.height<=0)throw new Error('Invalid PDF page size.');
          const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
          await page.render({canvas:canvas as any,canvasContext:canvas.getContext('2d') as any,viewport}).promise;
          ocr??=await createOcr();const recognized=await ocr.read(canvas.toBuffer('image/png'));ocrPages++;
          text+=`\nOCR (machine transcription, confidence ${Math.round(recognized.confidence)}%; verify against page):\n${recognized.text}`;
        }
      }
      if(doc.numPages>40)text+='\n[Only the first 40 pages were extracted.]';
    } finally { await ocr?.close(); await loading.destroy(); }
    if(!text.replace(/Page \d+/g,'').trim())throw new Error('No text could be extracted or recognized from this PDF.');
  } else if (['docx','pptx','xlsx'].includes(ext)) {
    const entries = officeEntries(data);
    if(ext==='xlsx') {
      if(!entries['xl/workbook.xml'])throw new Error('Not an XLSX workbook.');
      const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(data) as any);
      for(const sheet of book.worksheets.slice(0,10)) {
        text+=`\nSheet: ${sheet.name}\n`;
        sheet.eachRow((row,n)=>{if(n<=500&&text.length<=64000)text+=row.values instanceof Array?row.values.slice(1,31).map(v=>typeof v==='object'?JSON.stringify(v):String(v??'')).join('\t')+'\n':'';});
      }
      text+='\n[Extraction limited to 10 sheets, 500 rows and 30 columns per sheet; formulas are not evaluated.]';
    } else {
      const names=Object.keys(entries).filter(p=>ext==='docx'?p==='word/document.xml':/^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
      if(!names.length)throw new Error('Document content is missing.');
      text=names.map(p=>xmlText(Buffer.from(entries[p]).toString('utf8'))).join('\n\n');
    }
  } else throw new Error('Supported binary attachments: PNG, JPEG, WebP, PDF, DOCX, XLSX and PPTX.');
  if(text.length>64000)text=text.slice(0,64000)+'\n[Extracted text truncated at 64,000 characters.]';
  parentPort!.postMessage({text,mime});
} catch(error) { parentPort!.postMessage({error:error instanceof Error?error.message:'Attachment could not be read.'}); }
