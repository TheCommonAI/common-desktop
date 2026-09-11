const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {checkedFetch}=require('../src/main/http.cjs');
const {Service}=require('../src/main/service.cjs');
async function server(t,fn){const s=http.createServer(fn);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();s.close();});return 'http://127.0.0.1:'+s.address().port;}
test('401 errors distinguish worker and gateway without echoing response secrets',async t=>{
 const url=await server(t,(q,r)=>{r.statusCode=401;if(q.url==='/worker')r.setHeader('X-Common-Node','fixture');r.end(JSON.stringify(q.url==='/gateway'?{detail:"this token doesn't match any registered node — private-secret"}:q.url==='/missing'?{detail:'the network answers its contributors. private-secret'}:{error:'private-secret'}));});
 for(const [route,code]of [['worker','worker_auth'],['gateway','registration_expired'],['missing','registration_missing'],['unknown','auth_unknown']])await assert.rejects(checkedFetch(url+'/'+route),e=>{assert.equal(e.code,code);assert.ok(!e.message.includes('private-secret'));return true;});
});
test('oversized and non-JSON errors remain bounded and do not expose body content',async t=>{
 const url=await server(t,(_q,r)=>{r.statusCode=401;r.end('private-secret'.repeat(3000));});
 await assert.rejects(checkedFetch(url),e=>e.code==='auth_unknown'&&!e.message.includes('private-secret'));
});
for(const kind of ['expired','worker','unknown','manual'])test('network chat recovery: '+kind,async t=>{
 let calls=0,registrations=0;
 const gateway=await server(t,(q,r)=>{calls++;q.resume();if(calls===1||kind!=='expired'){r.statusCode=401;if(kind==='worker')r.setHeader('X-Common-Node','fixture');r.end(JSON.stringify({detail:kind==='unknown'?'Unknown auth':"this token doesn't match any registered node"}));return;}assert.equal(q.headers['x-common-node-token'],'new-token');r.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');});
 const settings={value:{gateway,model:'test',contributing:true,idleOnly:false,pauseBattery:false,chatTokens:kind==='manual'?{[gateway]:'manual-token'}:{},identities:{[gateway]:{node_token:'old-token'}}},public(){return {};}};
 const service=new Service(settings,{dataDir:'.',openPath:()=>{}});service.registeredGateway=gateway;
 service.stopWorker=async()=>{};service.startWorker=async()=>{registrations++;settings.value.identities[gateway].node_token='new-token';};
 const request=service.chat({target:'network',messages:[{role:'user',content:'synthetic'}]});
 if(kind==='expired'){assert.equal((await request).content,'ok');assert.equal(calls,2);assert.equal(registrations,1);}else{await assert.rejects(request);assert.equal(calls,1);assert.equal(registrations,0);}
});
