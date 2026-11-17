#!/usr/bin/env node
// Stand-in Codex CLI: logs argv, emits JSONL like `codex exec --experimental-json`
const fs=require("fs"),path=require("path");
const a=process.argv.slice(2); fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(a)+"\n"); if (process.env.CONTROL_PLANE_API_KEY || process.env.OPENAI_API_KEY) fs.appendFileSync(process.env.FAKE_CODEX_LOG + ".leak", "leaked\n");
const cdI=a.indexOf("--cd"); const cd=cdI>=0?a[cdI+1]:process.cwd();
const resume=a.includes("resume"); const tid=resume? a[a.indexOf("resume")+1] : "th_"+Math.random().toString(16).slice(2,10);
const out=o=>console.log(JSON.stringify(o));
// Windows test shim: exit with the wrapper exe (Windows ends the real codex.exe with the bridge, but not this grandchild).
if(process.platform==="win32") setInterval(()=>{try{process.kill(process.ppid,0)}catch{process.exit(1)}},200).unref();
let input="";process.stdin.on("data",d=>input+=d);process.stdin.on("end",async()=>{
  out({type:"thread.started",thread_id:tid});out({type:"turn.started"});
  if(input.includes("LONG")&&!resume){ out({type:"item.started",item:{id:"c1",type:"command_execution",command:"sleep 30",aggregated_output:"",status:"in_progress"}}); await new Promise(r=>setTimeout(r,30000)); }
  if(input.includes("EDITA")){ fs.writeFileSync(path.join(cd,"a.txt"),"changed"); fs.rmSync(path.join(cd,"b.txt"),{force:true}); }
  if(resume) fs.writeFileSync(path.join(cd,"resumed.txt"),"yes\n"); else if(!input.includes("NOWRITE")) fs.writeFileSync(path.join(cd,"out.txt"),input.slice(0,40));
  out({type:"item.completed",item:{id:"m",type:"agent_message",text:input.includes("PRINTKEY")?"key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 ok":resume?"Resumed and finished.":"Done."}});
  out({type:"turn.completed",usage:{input_tokens:1,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:1,reasoning_output_tokens:0}});
});
