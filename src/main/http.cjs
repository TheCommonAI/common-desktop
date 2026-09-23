const {Performance}=require('./performance.cjs');
// How this machine identifies itself to the gateway. The terminal client and
// this app share every URL, endpoint and credential, so the client string is
// the only thing that separates an app user from a terminal user in the
// gateway's records -- sent as both a header and a registration field.
const CLIENT='common-desktop/'+require('../../package.json').version;
const gatewayHeaders=(extra={})=>({'X-Common-Client':CLIENT,'User-Agent':CLIENT,...extra});
// Read only a small error envelope. Never display arbitrary upstream text,
// which can contain credentials, prompts or a proxy's HTML error page.
async function errorEnvelope(response){
 const reader=response.body?.getReader();if(!reader)return {};
 let timer;const chunks=[];let bytes=0;
 try{return await Promise.race([(async()=>{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>8192)return {};chunks.push(value);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return {};}})(),new Promise(resolve=>{timer=setTimeout(()=>resolve({}),2000);})]);}
 finally{clearTimeout(timer);await reader.cancel().catch(()=>{});}
}
async function checkedFetch(url,options={}){
 const r=await fetch(url,{redirect:'error',...options});if(r.ok)return r;
 const body=await errorEnvelope(r);let origin='unknown',code='http_error';if(r.status===400&&typeof body?.detail==='string'&&/does not resolve/.test(body.detail))code='endpoint_dns_pending';
 let help=r.status===503?'No suitable worker is available. Try again shortly or use This computer.':r.status===409?'This node could not be registered with its saved identity.':'Check the connection and try again.';
 if([401,403].includes(r.status)){
  const detail=typeof body?.detail==='string'?body.detail:'';
  if(r.headers.has('x-common-node')||body?.error==='Authentication required'){
   origin='worker';code='worker_auth';help='A worker rejected the gateway credentials. Your chat token may be valid. The gateway operator needs to check its worker_token deployment and node registration; reinstalling models will not fix this.';
  }else if(detail.startsWith("this token doesn't match any registered node")){
   origin='gateway';code='registration_expired';help='The gateway no longer recognises this PC registration. Pause and restart contribution to register again.';
  }else if(detail.startsWith('the network answers its contributors.')){
   origin='gateway';code='registration_missing';help='The gateway did not receive a contributor token. Start contributing before using network chat.';
  }else{code='auth_unknown';help='Authentication was rejected, but this response does not identify whether it came from the gateway or a worker. Report this error code and check the gateway deployment.';}
 }
 const error=new Error(`HTTP ${r.status} [${code}]. ${help}`);Object.assign(error,{status:r.status,origin,code});throw error;
}
async function json(url,options={}){return(await checkedFetch(url,{signal:AbortSignal.timeout(12000),...options})).json();}
async function* lines(body){const decoder=new TextDecoder();let buffer='';for await(const chunk of body){buffer+=decoder.decode(chunk,{stream:true});if(buffer.length>4*1024*1024)throw new Error('Oversized response event.');let i;while((i=buffer.indexOf('\n'))>=0){yield buffer.slice(0,i).replace(/\r$/,'');buffer=buffer.slice(i+1);}}buffer+=decoder.decode();if(buffer)yield buffer;}
async function streamChat(url,headers,payload,signal,onDelta){const timing=new Performance({model:payload.model});timing.start();const r=await checkedFetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({...payload,stream:true,stream_options:{include_usage:true}}),signal});const receipt={node:r.headers.get('x-common-node'),topology:r.headers.get('x-common-topology')};let content='',event=[],completed=false;function consume(){if(!event.length)return;const data=event.join('\n');event=[];if(data==='[DONE]'){completed=true;return;}const p=JSON.parse(data);timing.item(p);if(p.error)throw new Error('The inference service returned an error.');if(p.choices?.some(c=>c.finish_reason!=null))completed=true;const delta=p.choices?.[0]?.delta?.content||'';if(typeof delta!=='string')return;content+=delta;if(content.length>2*1024*1024)throw new Error('The reply exceeded the desktop output limit.');if(delta)onDelta(delta);}try{for await(const line of lines(r.body)){if(line==='')consume();else if(line.startsWith('data:'))event.push(line.slice(5).trimStart());}consume();}finally{if(!r.body.locked)await r.body.cancel().catch(()=>{});}if(!completed)throw new Error('The connection ended before the answer finished. Please retry.');if(!content)throw new Error('The model returned no text. Try another model or a shorter question.');return {content,receipt:{...receipt,performance:timing.finish(true)}};}
module.exports={checkedFetch,json,lines,streamChat,gatewayHeaders,CLIENT};
