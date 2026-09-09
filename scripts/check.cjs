const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
function visit(dir){for(const f of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,f.name);if(f.isDirectory())visit(p);else if(/\.(c?js)$/.test(p))execFileSync(process.execPath,['--check',p],{stdio:'inherit'});}}
['src','scripts','tests'].forEach(visit);console.log('JavaScript syntax checks passed.');
