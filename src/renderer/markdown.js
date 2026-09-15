const markdown=(()=>{
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const plain=v=>v.replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/&amp;/g,'&');
const href=v=>{try{const u=new URL(plain(String(v).trim()));return u.protocol==='https:'||u.protocol==='http:'?esc(u.href):'';}catch{return '';}};
const RULE=/^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/,HEAD=/^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/,FENCE=/^ {0,3}(`{3,}|~{3,})[ \t]*([^`~]*?)[ \t]*$/,QUOTE=/^ {0,3}&gt;[ \t]?(.*)$/,ITEM=/^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/,CELLS=/^[ \t]*\|(.*)\|[ \t]*$/,ALIGN=/^[ \t]*\|[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|[ \t]*$/;
const width=v=>v.replace(/\t/g,'    ').length,block=l=>RULE.test(l)||HEAD.test(l)||FENCE.test(l)||QUOTE.test(l)||ITEM.test(l);
const table=(l,next)=>CELLS.test(l)&&ALIGN.test(next||'');
let held=[];
const hold=html=>{held.push(html);return '\u0000'+(held.length-1)+'\u0000';};
const release=s=>s.replace(/\u0000(\d+)\u0000/g,(_,n)=>release(held[n]));
const link=(url,label)=>{const h=href(url);return h?hold(`<a class="mdlink" href="${h}" data-link="${h}">${label}</a>`):'';};
function inline(s){
 s=s.replace(/(`+)([^\n]*?[^`])\1(?!`)/g,(_,t,c)=>hold(`<code>${c.replace(/^ (.*) $/,'$1')}</code>`));
 s=s.replace(/!?\[([^\]\n]*)\]\([ \t]*([^\s)]+)(?:[ \t]+&quot;[^)\n]*&quot;)?[ \t]*\)/g,(m,label,url)=>link(url,inline(label)||url)||m);
 s=s.replace(/(^|[^\w@/.])((?:https?:\/\/|www\.)[^\s]+)/g,(m,lead,raw)=>{const trimmed=raw.replace(/(?:&gt;|&lt;|&quot;|&#39;|[.,;:!?)\]}])+$/,'');return trimmed?lead+(link(/^www\./.test(trimmed)?'https://'+trimmed:trimmed,trimmed)||trimmed)+raw.slice(trimmed.length):m;});
 s=s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g,'<strong><em>$1</em></strong>').replace(/___(?=\S)([\s\S]*?\S)___/g,'<strong><em>$1</em></strong>');
 s=s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g,'<strong>$1</strong>').replace(/__(?=\S)([\s\S]*?\S)__/g,'<strong>$1</strong>');
 s=s.replace(/(^|[^*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g,'$1<em>$2</em>').replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g,'$1<em>$2</em>');
 return s.replace(/~~(?=\S)([\s\S]*?\S)~~/g,'<del>$1</del>');
}
function items(lines,i){
 const first=lines[i].match(ITEM),ordered=/\d/.test(first[2]),base=width(first[1]),collected=[];
 while(i<lines.length){
  const line=lines[i],item=line.match(ITEM);
  if(item&&width(item[1])<=base+1){if(/\d/.test(item[2])!==ordered)break;collected.push([item[3]]);i++;continue;}
  if(!collected.length)break;
  const tail=collected[collected.length-1];
  if(!line.trim()){if(lines[i+1]!==undefined&&(ITEM.test(lines[i+1])||/^[ \t]{2,}\S/.test(lines[i+1]))){tail.push('');i++;continue;}break;}
  if(/^[ \t]+\S/.test(line)){tail.push(line.replace(/^(?: {1,4}|\t)/,''));i++;continue;}
  if(block(line)||table(line,lines[i+1]))break;
  tail.push(line);i++;
 }
 const start=ordered?Number(first[2].slice(0,-1)):1;
 const body=collected.map(item=>{const html=parse(item.join('\n')),once=html.match(/^<p>([\s\S]*?)<\/p>([\s\S]*)$/);return `<li>${once&&!once[2].includes('<p>')?once[1]+once[2]:html}</li>`;}).join('');
 return [ordered?`<ol${start===1?'':` start="${start}"`}>${body}</ol>`:`<ul>${body}</ul>`,i];
}
function parse(text){
 const lines=text.split('\n');let out='',i=0,m;
 while(i<lines.length){
  const line=lines[i];
  if(!line.trim()){i++;continue;}
  if(m=line.match(FENCE)){
   const close=new RegExp('^ {0,3}'+m[1][0]+'{'+m[1].length+',}[ \\t]*$'),body=[];i++;
   while(i<lines.length&&!close.test(lines[i]))body.push(lines[i++]);
   if(i<lines.length)i++;
   out+=`<pre class="mdcode"${m[2]?` data-lang="${m[2]}"`:''}><code>${body.join('\n')}</code></pre>`;continue;
  }
  if(RULE.test(line)){out+='<hr>';i++;continue;}
  if(m=line.match(HEAD)){const level=Math.min(6,m[1].length+2);out+=`<h${level} class="mdh">${inline(m[2])}</h${level}>`;i++;continue;}
  if(QUOTE.test(line)){const body=[];while(i<lines.length&&lines[i].trim()&&(QUOTE.test(lines[i])||!block(lines[i]))){body.push((lines[i].match(QUOTE)||[,lines[i]])[1]);i++;}out+=`<blockquote>${parse(body.join('\n'))}</blockquote>`;continue;}
  if(table(line,lines[i+1])){
   const cut=r=>r.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
   const head=cut(line),align=cut(lines[i+1]).map(c=>/^:-+:$/.test(c)?' class="mdmid"':/-+:$/.test(c)?' class="mdend"':''),rows=[];
   i+=2;while(i<lines.length&&CELLS.test(lines[i]))rows.push(cut(lines[i++]));
   out+=`<div class="table-scroll"><table><thead><tr>${head.map((c,x)=>`<th${align[x]||''}>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${head.map((_,x)=>`<td${align[x]||''}>${inline(r[x]||'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;continue;
  }
  if(ITEM.test(line)){const [html,next]=items(lines,i);out+=html;i=next;continue;}
  const body=[];
  do body.push(lines[i++]);while(i<lines.length&&lines[i].trim()&&!block(lines[i])&&!table(lines[i],lines[i+1]));
  out+=`<p>${inline(body.join('\n')).replace(/\n/g,'<br>')}</p>`;
 }
 return out;
}
return text=>{held=[];const source=String(text??'').replace(/\u0000/g,'').replace(/\r\n?/g,'\n');return source.trim()?release(parse(esc(source))):'';};
})();
if(typeof window!=='undefined')window.markdown=markdown;
if(typeof module!=='undefined')module.exports={markdown};
