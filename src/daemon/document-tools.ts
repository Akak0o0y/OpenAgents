import { z } from 'zod';
import { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate';
import { workspacePath } from './artifacts.js';
import { formulaResults } from './spreadsheet-formulas.js';

const chartInput=z.object({title:z.string().max(100),type:z.enum(['bar','line','pie']).default('bar'),labels:z.array(z.string().max(60)).min(1).max(20),values:z.array(z.number().finite()).min(1).max(20)}).strict();
const scalar=z.union([z.string().max(2000),z.number().finite(),z.boolean(),z.null()]);

export const documentInput = z.object({
  path: z.string().min(1).max(200), title: z.string().trim().min(1).max(160),
  format: z.enum(['docx', 'xlsx', 'pptx']),
  template:z.enum(['standard','executive','academic']).default('standard'),
  sections:z.array(z.object({heading:z.string().max(160),text:z.string().max(4000)}).strict()).max(40).optional(),
  table:z.array(z.array(z.string().max(500)).max(8)).max(30).optional(),
  charts:z.array(chartInput).max(3).optional(),
  paragraphs: z.array(z.string().max(4000)).max(100).optional(),
  rows: z.array(z.array(z.union([scalar,z.object({formula:z.string().min(1).max(300)}).strict()])).max(30)).max(500).optional(),
  slides: z.array(z.object({ title: z.string().max(100), bullets: z.array(z.string().max(180)).max(6).default([]),rightBullets:z.array(z.string().max(180)).max(6).optional(),chart:chartInput.optional(),table:z.array(z.array(z.string().max(100)).max(6)).max(10).optional() }).strict()).max(30).optional(),
}).strict();

/** Read bounded OPC packages without extracting paths to the host filesystem. */
export function officeEntries(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0, count = 0;
  return unzipSync(bytes, { filter: entry => {
    total += entry.originalSize; count++;
    if (count > 2000 || !Number.isSafeInteger(total) || total > 16 * 1024 * 1024 || entry.originalSize > 4 * 1024 * 1024) throw new Error('Office file exceeds its extracted-content limit.');
    if (entry.name.includes('..') || entry.name.includes('\\') || entry.name.startsWith('/')) throw new Error('Office archive contains unsafe paths.');
    if (entry.originalSize > 0 && (/vbaProject|\.bin$/i.test(entry.name)||(/embeddings\//i.test(entry.name)&&!entry.name.endsWith('.xlsx')))) throw new Error('Macro and embedded-object files are not supported.');
    return /\.xml$|\.rels$/.test(entry.name);
  } });
}

export async function createDocument(raw: unknown): Promise<{ path: string; bytes: Buffer; summary: string }> {
  const input = documentInput.parse(raw);
  const file = workspacePath(input.path);
  if (!file.toLowerCase().endsWith(`.${input.format}`)) throw new Error('The document filename must match its format.');
  if (Buffer.byteLength(JSON.stringify(input)) > 128000) throw new Error('Document source exceeds 128 KB.');
  let bytes: Buffer;
  const accent=input.template==='executive'?'173F5F':input.template==='academic'?'354B35':'152335';
  const font=input.template==='academic'?'Georgia':'Aptos';
  for(const chart of [...(input.charts??[]),...(input.slides??[]).flatMap(s=>s.chart?[s.chart]:[])])if(chart.labels.length!==chart.values.length)throw new Error('Chart labels and values must have equal lengths.');
  if (input.format === 'docx') {
    if ((!input.paragraphs?.length&&!input.sections?.length&&!input.table?.length) || input.rows || input.slides || input.charts) throw new Error('DOCX requires paragraphs, sections or a table.');
    const children:Array<Paragraph|Table>=[new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }), ...(input.paragraphs??[]).map(text=>new Paragraph(text))];
    for(const section of input.sections??[])children.push(new Paragraph({text:section.heading,heading:HeadingLevel.HEADING_1}),new Paragraph(section.text));
    if(input.table?.length)children.push(new Table({width:{size:100,type:WidthType.PERCENTAGE},rows:input.table.map(row=>new TableRow({children:row.map(text=>new TableCell({children:[new Paragraph(text)]}))}))}));
    const doc = new Document({ title: input.title, creator: 'OpenAgents', styles:{default:{document:{run:{font,size:22,color:accent},paragraph:{spacing:{after:160}}}}}, sections: [{ children }] });
    bytes = await Packer.toBuffer(doc);
  } else if (input.format === 'xlsx') {
    if (!input.rows?.length || input.paragraphs || input.slides || input.sections || input.table) throw new Error('XLSX requires rows, with optional charts.');
    const book = new ExcelJS.Workbook(); book.creator = 'OpenAgents'; book.title = input.title;
    const sheet = book.addWorksheet('Data'); const results=formulaResults(input.rows);
    sheet.addRows(input.rows.map((row,r)=>row.map((v,c)=>v&&typeof v==='object'?{formula:v.formula.replace(/^=/,''),result:results.get((c<26?String.fromCharCode(65+c):'A'+String.fromCharCode(65+c-26))+(r+1))}:v)));
    sheet.getRow(1).font = { bold: true, color:{argb:'FF'+accent},name:font }; sheet.views = [{ state: 'frozen', ySplit: 1 }];
    for (const column of sheet.columns) column.width = 24;
    // Only scalar cell values: formula-like strings stay literal, no external links or formulas.
    bytes = Buffer.from(await book.xlsx.writeBuffer());
    if(input.charts?.length)bytes=spreadsheetCharts(bytes,input.charts);
  } else {
    if (!input.slides?.length || input.paragraphs || input.rows || input.sections || input.table || input.charts) throw new Error('PPTX requires slides with optional columns, chart or table.');
    // The package's CJS declaration wraps its default under NodeNext; its ESM export is the class.
    const Presentation = PptxGenJS as unknown as typeof PptxGenJS.default;
    const deck = new Presentation(); deck.layout = 'LAYOUT_WIDE'; deck.author = 'OpenAgents'; deck.title = input.title;
    for (const item of input.slides) {
      const slide = deck.addSlide(); slide.background = { color: 'F5F7FA' };
      if([!!item.rightBullets,!!item.chart,!!item.table].filter(Boolean).length>1||(item.chart||item.table)&&item.bullets.length)throw new Error('Choose one slide body: bullets/columns, chart or table.');
      slide.addText(item.title, { x: 0.65, y: 0.45, w: 12, h: 1.15, fontSize: 28, bold: true, fontFace:font,color: accent, breakLine: false });
      item.bullets.forEach((text, i) => slide.addText(text, { x: 0.85, y: 1.8 + i * 0.8, w: item.rightBullets?5.5:11.6, h: 0.72, fontSize: 20,fontFace:font, color: '25364D', bullet: true }));
      item.rightBullets?.forEach((text,i)=>slide.addText(text,{x:7,y:1.8+i*0.8,w:5.4,h:0.72,fontSize:20,fontFace:font,color:'25364D',bullet:true}));
      if(item.table?.length)slide.addTable(item.table.map(row=>row.map(text=>({text}))),{x:0.8,y:1.8,w:11.7,h:4.6,fontSize:16,color:accent,border:{type:'solid',pt:1,color:'CBD5E1'},autoPage:false});
      if(item.chart)slide.addChart(deck.ChartType[item.chart.type],[{name:item.chart.title,labels:item.chart.labels,values:item.chart.values}],{x:0.8,y:1.8,w:11.7,h:4.8,showTitle:true,title:item.chart.title,showLegend:false});
    }
    bytes = Buffer.from(await deck.write({ outputType: 'nodebuffer', compression: true }) as ArrayBuffer);
  }
  if (bytes.length > 4 * 1024 * 1024) throw new Error('Generated document exceeds 4 MiB.');
  const entries = officeEntries(bytes);
  const required = input.format === 'docx' ? 'word/document.xml' : input.format === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml';
  if (!entries['[Content_Types].xml'] || !entries[required]) throw new Error('Generated document failed its package checks.');
  if (Object.entries(entries).some(([name, data]) => name.endsWith('.rels') && /TargetMode="External"/.test(strFromU8(data)))) throw new Error('External document relationships are not allowed.');
  return { path: file, bytes, summary: `Created ${file}; package structure checked. Visual layout and factual content have not been independently reviewed.` };
}

/** Native XLSX chart parts; source data is embedded in the chart cache, never linked externally. */
function spreadsheetCharts(bytes:Buffer,charts:Array<z.infer<typeof chartInput>>):Buffer{
  const entries=unzipSync(bytes);const xml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
  const put=(p:string,s:string)=>{entries[p]=strToU8(s);};
  const chartNs='http://schemas.openxmlformats.org/drawingml/2006/chart';
  for(const [i,c] of charts.entries()){
    const type=c.type==='bar'?'barChart':c.type==='line'?'lineChart':'pieChart';
    const categories=c.labels.map((v,j)=>`<c:pt idx="${j}"><c:v>${xml(v)}</c:v></c:pt>`).join('');
    const values=c.values.map((v,j)=>`<c:pt idx="${j}"><c:v>${v}</c:v></c:pt>`).join('');
    const axes=c.type==='pie'?'':`<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="1"/><c:crosses val="autoZero"/></c:valAx>`;
    put(`xl/charts/chart${i+1}.xml`,`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="${chartNs}"><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/><c:${type}>${c.type==='bar'?'<c:barDir val="col"/><c:grouping val="clustered"/>':c.type==='line'?'<c:grouping val="standard"/>':''}<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${xml(c.title)}</c:v></c:tx><c:cat><c:strLit><c:ptCount val="${c.labels.length}"/>${categories}</c:strLit></c:cat><c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="${c.values.length}"/>${values}</c:numLit></c:val></c:ser>${c.type==='pie'?'':'<c:axId val="1"/><c:axId val="2"/>'}</c:${type}>${axes}</c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`);
  }
  const relNs='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  put('xl/drawings/drawing1.xml',`<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${charts.map((_,i)=>`<xdr:twoCellAnchor><xdr:from><xdr:col>32</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${i*18}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>42</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${i*18+16}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i+1}" name="Chart ${i+1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${chartNs}"><c:chart xmlns:c="${chartNs}" xmlns:r="${relNs}" r:id="rId${i+1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`).join('')}</xdr:wsDr>`);
  put('xl/drawings/_rels/drawing1.xml.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${charts.map((_,i)=>`<Relationship Id="rId${i+1}" Type="${relNs}/chart" Target="../charts/chart${i+1}.xml"/>`).join('')}</Relationships>`);
  put('xl/worksheets/_rels/sheet1.xml.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdCharts" Type="${relNs}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
  put('xl/worksheets/sheet1.xml',strFromU8(entries['xl/worksheets/sheet1.xml']).replace('</worksheet>','<drawing r:id="rIdCharts"/></worksheet>'));
  put('[Content_Types].xml',strFromU8(entries['[Content_Types].xml']).replace('</Types>',`<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>${charts.map((_,i)=>`<Override PartName="/xl/charts/chart${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('')}</Types>`));
  return Buffer.from(zipSync(entries));
}
