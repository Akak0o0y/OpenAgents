/** Small deterministic formula evaluator. No eval, external links, macros, volatile or network functions. */
export function formulaResults(rows: unknown[][]): Map<string,number> {
  const cache=new Map<string,number>(),active=new Set<string>();
  const column=(s:string)=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
  const cell=(address:string):number=>{
    if(cache.has(address))return cache.get(address)!;
    if(active.has(address))throw new Error(`Circular spreadsheet formula at ${address}.`);
    const m=/^([A-Z]{1,2})([1-9][0-9]{0,2})$/.exec(address);if(!m)throw new Error('Unsupported cell reference.');
    const row=Number(m[2])-1,col=column(m[1]);if(row>=500||col>=30)throw new Error('Formula reference is outside the sheet bounds.');
    const value=rows[row]?.[col];if(typeof value==='number')return value;
    if(typeof value!=='object'||value===null||!('formula' in value))throw new Error(`Formula cell ${address} must contain a number or supported formula.`);
    active.add(address);
    try{const result=expression(String(value.formula));if(!Number.isFinite(result))throw new Error('Formula produced a non-finite value.');cache.set(address,result);return result;}finally{active.delete(address);}
  };
  const expression=(source:string):number=>{
    const s=source.replace(/^=/,'').replace(/\s/g,'').toUpperCase();
    const tokens=s.match(/(?:\d+(?:\.\d+)?|[A-Z]+[0-9]*|[()+\-*/,\:])/g)??[];
    if(tokens.join('')!==s||tokens.length>200)throw new Error('Unsupported spreadsheet formula syntax.');
    let i=0;
    const primary=():number=>{
      const t=tokens[i++];if(!t)throw new Error('Incomplete formula.');
      if(t==='-')return -primary();if(t==='+')return primary();
      if(t==='('){const v=add();if(tokens[i++]!==')')throw new Error('Unclosed formula parenthesis.');return v;}
      if(/^\d/.test(t))return Number(t);
      if(/^[A-Z]+\d+$/.test(t))return cell(t);
      if(!['SUM','AVERAGE','MIN','MAX','COUNT'].includes(t)||tokens[i++]!=='(')throw new Error(`Unsupported formula function ${t}.`);
      const values:number[]=[];
      while(tokens[i]!==')'){
        if(/^[A-Z]+\d+$/.test(tokens[i]??'')&&tokens[i+1]===':'){
          const a=/^([A-Z]+)(\d+)$/.exec(tokens[i++])!;i++;const b=/^([A-Z]+)(\d+)$/.exec(tokens[i++]??'');if(!b)throw new Error('Invalid formula range.');
          const first=column(a[1]),last=column(b[1]),r0=Number(a[2]),r1=Number(b[2]);
          if(first>last||r0>r1||last>=30||r1>500)throw new Error('Invalid formula range bounds.');
          for(let r=r0;r<=r1;r++)for(let c=first;c<=last;c++){const name=c<26?String.fromCharCode(65+c):'A'+String.fromCharCode(65+c-26);values.push(cell(name+r));}
        }else values.push(add());
        if(tokens[i]===',')i++;else if(tokens[i]!==')')throw new Error('Invalid formula arguments.');
      }
      i++;if(!values.length)throw new Error('Formula needs arguments.');
      return t==='SUM'?values.reduce((a,b)=>a+b,0):t==='AVERAGE'?values.reduce((a,b)=>a+b,0)/values.length:t==='MIN'?Math.min(...values):t==='MAX'?Math.max(...values):values.length;
    };
    const multiply=():number=>{let n=primary();while(tokens[i]==='*'||tokens[i]==='/'){const op=tokens[i++],right=primary();n=op==='*'?n*right:n/right;}return n;};
    const add=():number=>{let n=multiply();while(tokens[i]==='+'||tokens[i]==='-'){const op=tokens[i++],right=multiply();n=op==='+'?n+right:n-right;}return n;};
    const value=add();if(i!==tokens.length)throw new Error('Unexpected formula tokens.');return value;
  };
  rows.forEach((row,r)=>row.forEach((value,c)=>{if(typeof value==='object'&&value&&'formula' in value)cell((c<26?String.fromCharCode(65+c):'A'+String.fromCharCode(65+c-26))+(r+1));}));
  return cache;
}
