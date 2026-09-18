const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{once,EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {Settings,normalizeGateway}=require('../src/main/settings.cjs'),{Service,policy,helperExit}=require('../src/main/service.cjs'),{streamChat}=require('../src/main/http.cjs'),{createWorker}=require('../src/main/worker.cjs'),{download}=require('../src/main/downloads.cjs');
async function server(t,fn){const s=http.createServer(fn);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();s.close();});return 'http://127.0.0.1:'+s.address().port;}
function config(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'common-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {settings:new Settings(dir),dir,identity:memoryIdentity()};}
// Never let a test read or write the real ~/.common-network/identity.json:
// that file is the machine's live node credential, shared with the terminal.
function memoryIdentity(seed=null){let v=seed;const match=g=>v&&typeof g==='string'&&v.gateway.replace(/\/$/,'')===g.replace(/\/$/,'');return {IDENTITY_FILE:'(memory)',read:()=>v,forGateway:g=>match(g)?v:null,write:e=>{v={...v,...e};},clear:g=>{if(match(g))v=null;},current:()=>v};}
const answer='data: {"choices":[{"delta":{"content":"fixture 🌿"}}]}\n\ndata: [DONE]\n\n';
test('settings persist and credentials remain gateway-specific',t=>{const {settings,dir,identity}=config(t);settings.update({gateway:'https://one.example/',chatToken:'one',idleOnly:false});settings.update({gateway:'https://two.example',chatToken:'two'});const next=new Settings(dir);assert.equal(next.value.chatTokens['https://one.example'],'one');assert.equal(next.value.chatTokens['https://two.example'],'two');assert.equal(next.value.idleOnly,false);assert.equal('chatTokens'in next.public(),false);assert.equal('identities'in next.public(),false);});
test('settings reject unsupported model tags, credentials in URLs and invalid concurrency',t=>{const {settings}=config(t);assert.throws(()=>normalizeGateway('https://user:pass@example.com'));assert.throws(()=>settings.update({model:'x:cloud'}));assert.throws(()=>settings.update({concurrency:10}));});
test('idle and battery policies pause and resume correctly',()=>{const s={contributing:true,idleOnly:true,idleMinutes:5,pauseBattery:true};assert.match(policy(s,{battery:false,idleSeconds:299}),/idle/);assert.equal(policy(s,{battery:false,idleSeconds:300}),null);assert.equal(policy(s,{battery:true,idleSeconds:999}),'Paused on battery');assert.equal(policy(s,{battery:false,idleSeconds:999,suspended:true}),'Computer asleep');});
test('SSE preserves split Unicode and routing metadata',async t=>{const url=await server(t,(_q,r)=>{r.setHeader('X-Common-Node','fixture');const bytes=Buffer.from(answer);for(let i=0;i<bytes.length;i+=3)r.write(bytes.subarray(i,i+3));r.end();});let text='';const out=await streamChat(url,{}, {},AbortSignal.timeout(2000),d=>text+=d);assert.equal(text,'fixture 🌿');assert.equal(out.receipt.node,'fixture');});
test('incomplete SSE is reported as interrupted',async t=>{const url=await server(t,(_q,r)=>r.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));await assert.rejects(streamChat(url,{}, {},AbortSignal.timeout(2000),()=>{}),/before the answer finished/);});
test('malformed SSE is rejected',async t=>{const url=await server(t,(_q,r)=>r.end('data: {broken}\n\n'));await assert.rejects(streamChat(url,{}, {},AbortSignal.timeout(2000),()=>{}));});
test('worker authentication, allowlist, model pinning and streaming match the baseline',async t=>{let forwarded=0;const upstream=await server(t,async(q,r)=>{let body='';for await(const c of q)body+=c;assert.equal(JSON.parse(body).model,'test');forwarded++;r.end(answer);});const w=await createWorker({model:'test',token:'fixture-token',ollama:upstream});t.after(()=>w.close());const url='http://127.0.0.1:'+w.port,headers={Authorization:'Bearer fixture-token'};assert.equal((await fetch(url+'/v1/models')).status,401);assert.equal((await fetch(url+'/api/pull',{method:'POST',headers,body:'{}'})).status,404);assert.equal((await fetch(url+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'wrong',messages:[]})})).status,400);const r=await fetch(url+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'test',messages:[],stream:true})});assert.equal(await r.text(),answer);assert.equal(forwarded,1);assert.equal(w.stats.completed,1);assert.equal(JSON.stringify(w.stats).includes('fixture'),false);});
test('worker concurrency and pause cancel active inference',async t=>{let mark;const started=new Promise(r=>mark=r),upstream=await server(t,(_q,r)=>{mark();r.write('data: ');});const w=await createWorker({model:'test',token:'token',ollama:upstream});t.after(()=>w.close());const url='http://127.0.0.1:'+w.port+'/v1/chat/completions',o={method:'POST',headers:{Authorization:'Bearer token'},body:JSON.stringify({model:'test',messages:[],stream:true})};const first=fetch(url,o);await started;assert.equal((await fetch(url,o)).status,503);w.pause();await first.then(r=>r.text()).catch(()=>{});assert.equal((await fetch(url,o)).status,503);});
test('download checksums and temporary-file cleanup',async t=>{const {dir}=config(t),url=await server(t,(_q,r)=>r.end('fixture')),file=path.join(dir,'file');await download(url,file);assert.equal(fs.readFileSync(file,'utf8'),'fixture');await assert.rejects(download(url,file,{sha256:'0'.repeat(64)}),/checksum/);assert.equal(fs.existsSync(file+'.part'),false);});
test('model pull reports progress and verifies installed inventory',async t=>{let installed=false;const url=await server(t,(q,r)=>{if(q.url==='/api/pull'){installed=true;r.end('{"status":"pulling","total":100,"completed":50}\n{"status":"success"}\n');}else if(q.url==='/api/tags')r.end(JSON.stringify({models:installed?[{name:'llama3.2:3b'}]:[]}));else r.end('{"models":[],"version":"fixture"}');});const {settings,dir,identity}=config(t);settings.update({gateway:url});const s=new Service(settings,{dataDir:dir,openPath:async()=>'',ollama:url,identity});t.after(()=>s.close());let seen=false;s.on('state',v=>{if(v.download?.completed===50)seen=true;});await s.pullModel();assert.equal(seen,true);assert.equal(s.state.ollama.models.length,1);assert.equal(s.state.download.done,true);});
test('cancelled pulls do not mark a model installed',async t=>{let mark;const started=new Promise(r=>mark=r),url=await server(t,(_q,r)=>{r.write('{"status":"pulling","total":100,"completed":1}\n');mark();});const {settings,dir,identity}=config(t),s=new Service(settings,{dataDir:dir,openPath:async()=>'',ollama:url,identity});t.after(()=>s.close());const pending=s.pullModel();await started;s.cancelDownload();await pending;assert.match(s.state.download.status,/Paused/);assert.equal(s.state.ollama.models.length,0);});
test('network credentials are absent from local chat requests',async t=>{const seen=[],url=await server(t,(q,r)=>{seen.push(q.headers['x-common-node-token']);r.end(answer);});const {settings,dir,identity}=config(t);settings.update({gateway:url,chatToken:'fixture-token'});const s=new Service(settings,{dataDir:dir,openPath:async()=>'',ollama:url,identity});t.after(()=>s.close());for(const target of ['network','local'])await s.chat({messages:[{role:'user',content:'fixture'}],target});assert.deepEqual(seen,['fixture-token',undefined]);});
test('registration, dropped-tunnel recovery and pause clean up the baseline worker',async t=>{const requests=[],children=[],url=await server(t,async(q,r)=>{let body='';for await(const c of q)body+=c;requests.push({method:q.method,url:q.url,headers:q.headers,body:body?JSON.parse(body):null});r.end(q.method==='POST'?'{"id":"fixture-id","node_token":"owner-token"}':'{}');});const {settings,dir,identity}=config(t);settings.update({gateway:url,contributing:true,idleOnly:false});fs.mkdirSync(path.join(dir,'bin'));fs.writeFileSync(path.join(dir,'bin',process.platform==='win32'?'cloudflared.exe':'cloudflared'),'fixture');const spawnTunnel=()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.exitCode=null;c.killed=false;c.kill=()=>{c.killed=true;c.exitCode=0;c.emit('exit',0);};children.push(c);setImmediate(()=>c.stdout.write('https://fixture.trycloudflare.com\n'));return c;};const s=new Service(settings,{dataDir:dir,openPath:async()=>'',spawnTunnel,identity});t.after(()=>s.close());s.state.ollama={online:true,models:[{name:'llama3.2:3b'}],running:[]};await s.reconcile();assert.equal(s.state.worker.status,'Contributing');assert.ok(requests[0].body.worker_token.length>=16);assert.equal(requests[0].body.endpoint_url,'https://fixture.trycloudflare.com/v1');const port=s.worker.port;children[0].exitCode=1;children[0].emit('exit',1);await s.tail;assert.equal(children.length,2);await assert.rejects(fetch('http://127.0.0.1:'+port+'/v1/models'));await s.update({contributing:false});assert.equal(s.worker,null);assert.equal(children[1].killed,true);assert.equal(requests.filter(r=>r.method==='DELETE').at(-1).headers['x-common-node-token'],'owner-token');});
function tunnelFixture(){const children=[];return {children,spawnTunnel:()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.exitCode=null;c.killed=false;c.kill=()=>{c.killed=true;c.exitCode=0;c.emit('exit',0);};children.push(c);setImmediate(()=>c.stdout.write('https://fixture.trycloudflare.com\n'));return c;}};}
async function registrar(t,requests){return server(t,async(q,r)=>{let body='';for await(const c of q)body+=c;requests.push({method:q.method,url:q.url,headers:q.headers,body:body?JSON.parse(body):null});r.end(q.method==='POST'?'{"id":"fixture-id","node_token":"owner-token"}':'{}');});}
// "The connection helper exited. Try again." is the wrong advice when the exit
// was Cloudflare rate-limiting quick tunnels: waiting is what helps, and the
// user cannot tell that from a message that names no cause. The rate-limit
// transcript here is verbatim from cloudflared 2026.9.0 -- note the refusal
// carries no timestamp and no ERR, which is why the level is not what we match.
const RATE_LIMITED='2026-09-18T12:04:06Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.\n2026-09-18T12:04:06Z INF Requesting new quick Tunnel on trycloudflare.com...\nquick tunnel provisioning failed with status 429: error code: 1015\n';
test('a helper that quits reports the reason it gave',async t=>{const requests=[],url=await registrar(t,requests),{settings,dir,identity}=config(t);settings.update({gateway:url,contributing:true,idleOnly:false});fs.mkdirSync(path.join(dir,'bin'));fs.writeFileSync(path.join(dir,'bin',process.platform==='win32'?'cloudflared.exe':'cloudflared'),'fixture');const spawnTunnel=()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.exitCode=null;c.killed=false;c.kill=()=>{c.killed=true;c.exitCode=1;};setImmediate(()=>{c.stderr.write(RATE_LIMITED);c.exitCode=1;c.emit('exit',1);});return c;};const s=new Service(settings,{dataDir:dir,openPath:async()=>'',spawnTunnel,identity});t.after(()=>s.close());s.state.ollama={online:true,models:[{name:'llama3.2:3b'}],running:[]};await s.reconcile();assert.match(s.state.worker.status,/rate-limiting/);assert.equal(requests.length,0);});
test('the helper exit reason survives every shape cloudflared writes it in',()=>{
 assert.match(helperExit(RATE_LIMITED),/Wait a few minutes/);
 assert.equal(helperExit('2026-09-18T12:04:06Z INF Requesting new quick Tunnel on trycloudflare.com...\n2026-09-18T12:04:07Z ERR Couldn\'t start tunnel error="connection refused"\n'),'The connection helper exited: Couldn\'t start tunnel error="connection refused"');
 assert.equal(helperExit('2026-09-18T12:04:06Z INF Requesting new quick Tunnel on trycloudflare.com...\n'),'The connection helper exited. Try again.');
 assert.equal(helperExit(''),'The connection helper exited. Try again.');
 assert.equal(helperExit('2026-09-18T12:04:07Z ERR '+'x'.repeat(400)).length,'The connection helper exited: '.length+201);
});
test('the app rejoins as the node this machine registered from the terminal',async t=>{const requests=[],url=await registrar(t,requests),{settings,dir}=config(t);const identity=memoryIdentity({gateway:url,name:'laptop-9f2c',node_id:'terminal-id',node_token:'terminal-token',catalogue_id:null,domain_tags:null,joined_at:1});settings.update({gateway:url,contributing:true,idleOnly:false});fs.mkdirSync(path.join(dir,'bin'));fs.writeFileSync(path.join(dir,'bin',process.platform==='win32'?'cloudflared.exe':'cloudflared'),'fixture');const {spawnTunnel}=tunnelFixture(),s=new Service(settings,{dataDir:dir,openPath:async()=>'',spawnTunnel,identity});t.after(()=>s.close());s.state.ollama={online:true,models:[{name:'llama3.2:3b'}],running:[]};await s.reconcile();assert.equal(s.state.worker.status,'Contributing');
 assert.equal(requests[0].body.name,'laptop-9f2c');
 assert.equal(requests[0].headers['x-common-node-token'],'terminal-token');
 assert.equal(identity.current().node_id,'fixture-id');
 assert.equal(identity.current().node_token,'owner-token');
 assert.equal(identity.current().name,'laptop-9f2c');
 assert.equal(s.snapshot().settings.name,'laptop-9f2c');
 assert.equal(s.token(),'owner-token');
 await s.update({contributing:false});
 assert.equal(identity.current(),null);
 assert.equal(settings.value.identities[url],undefined);});
test('every gateway request names the desktop client, and no local one does',async t=>{const requests=[],url=await registrar(t,requests),{settings,dir}=config(t);const identity=memoryIdentity();settings.update({gateway:url,contributing:true,idleOnly:false});fs.mkdirSync(path.join(dir,'bin'));fs.writeFileSync(path.join(dir,'bin',process.platform==='win32'?'cloudflared.exe':'cloudflared'),'fixture');const {spawnTunnel}=tunnelFixture(),s=new Service(settings,{dataDir:dir,openPath:async()=>'',spawnTunnel,identity});t.after(()=>s.close());s.state.ollama={online:true,models:[{name:'llama3.2:3b'}],running:[]};await s.reconcile();await s.refreshGateway();await s.catalogue();
 const stamp=/^common-desktop\/\d+\.\d+\.\d+$/;
 assert.ok(requests.length>=3);
 for(const r of requests)assert.match(r.headers['x-common-client']||'',stamp,r.method+' '+r.url);
 assert.match(requests[0].body.client,stamp);
 assert.equal(requests[0].body.region,null);
 const local=[],ollama=await server(t,(q,r)=>{local.push(q.headers);r.end(answer);});const s2=new Service(settings,{dataDir:dir,openPath:async()=>'',ollama,identity});t.after(()=>s2.close());await s2.chat({messages:[{role:'user',content:'fixture'}],target:'local'});
 assert.equal(local[0]['x-common-client'],undefined);});
test('registration waits out a tunnel hostname that is not resolvable yet',async t=>{
 // Measured against the production gateway: a fresh quick tunnel resolves on
 // public DNS at ~20s and is accepted at ~80s. Registering at ~5s always lost,
 // and losing used to discard the tunnel and open a new one -- a contributor
 // who never appears in the registry. The tunnel must survive the wait.
 const attempts=[];const url=await server(t,async(q,r)=>{
  attempts.push(q.url);
  if(attempts.length<3){r.writeHead(400,{'Content-Type':'application/json'});r.end(JSON.stringify({detail:"endpoint_url host 'x.trycloudflare.com' does not resolve — the gateway health checker would flag this node dead on its first pass anyway."}));return;}
  r.end('{"id":"late-id","node_token":"late-token"}');
 });
 const {settings,dir,identity}=config(t),s=new Service(settings,{dataDir:dir,openPath:async()=>'',identity});t.after(()=>s.close());
 const slept=[];
 const out=await s.register(url,{'Content-Type':'application/json'},'{}',{delay:1,sleep:async ms=>{slept.push(ms);}});
 assert.equal(out.node_token,'late-token');
 assert.equal(attempts.length,3);
 assert.equal(slept.length,2);
 assert.match(s.state.worker.status,/Waiting for the connection address/);
});
test('registration does not retry failures that are not the resolve race',async t=>{
 const attempts=[];const url=await server(t,(q,r)=>{attempts.push(q.url);r.writeHead(409,{'Content-Type':'application/json'});r.end('{"detail":"name taken"}');});
 const {settings,dir,identity}=config(t),s=new Service(settings,{dataDir:dir,openPath:async()=>'',identity});t.after(()=>s.close());
 await assert.rejects(s.register(url,{},'{}',{delay:1,sleep:async()=>{}}),/HTTP 409/);
 assert.equal(attempts.length,1,'a 409 must fail immediately, not be retried for two minutes');
});
test('registration gives up rather than retrying forever',async t=>{
 const attempts=[];const url=await server(t,(q,r)=>{attempts.push(q.url);r.writeHead(400,{'Content-Type':'application/json'});r.end('{"detail":"does not resolve"}');});
 const {settings,dir,identity}=config(t),s=new Service(settings,{dataDir:dir,openPath:async()=>'',identity});t.after(()=>s.close());
 await assert.rejects(s.register(url,{},'{}',{attempts:4,delay:1,sleep:async()=>{}}),/HTTP 400/);
 assert.equal(attempts.length,4);
});
test('the tunnel URL pattern ignores cloudflared own api host',async t=>{
 // cloudflared prints https://api.trycloudflare.com in its startup chatter. The
 // old pattern matched it, so the app could register Cloudflare's API as its
 // endpoint -- which resolves, registers cleanly, and serves nothing.
 const pattern=/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;
 assert.equal('https://api.trycloudflare.com'.match(pattern),null);
 assert.equal('Requesting new quick Tunnel on trycloudflare.com...'.match(pattern),null);
 assert.equal('https://examine-ooo-allied-memorabilia.trycloudflare.com'.match(pattern)[0],
   'https://examine-ooo-allied-memorabilia.trycloudflare.com');
 const chatter='2026-09-15 cloudflared will use https://api.trycloudflare.com\n+-----+\n| https://janet-infringement-showers-judges.trycloudflare.com |\n+-----+';
 assert.equal(chatter.match(pattern)[0],'https://janet-infringement-showers-judges.trycloudflare.com');
});
