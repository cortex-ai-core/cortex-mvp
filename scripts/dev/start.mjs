import { spawn,spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
await access('.local/dev/app.env').catch(()=>{throw new Error('Run npm run setup:local -- --email YOUR_COGNITO_EMAIL first.');});
const args=['compose',...(process.argv.includes('--documents')?['--profile','documents']:[]),'up','-d','--wait'];
if(spawnSync('docker',args,{stdio:'inherit'}).status!==0)throw new Error('Docker services failed to start.');
const children=[
  spawn('node',['--watch','server.js'],{stdio:'inherit',env:{...process.env,CORTEX_ENV:'local',NODE_ENV:'development'}}),
  spawn('npm',['run','dev','--','--port','3003'],{cwd:resolve('../cortex-ui-mvp'),stdio:'inherit',env:{...process.env,NEXT_PUBLIC_BACKEND_URL:'http://localhost:8082',NEXT_PUBLIC_DIRECT_UPLOAD:'false',CORTEX_NEXT_DIST_DIR:'.next-local'}}),
];
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
for(const child of children)child.on('exit',()=>stop());
console.log('Local UI: http://localhost:3003 | API: http://localhost:8082 | Database API: http://localhost:3004');
