import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json({limit:"32kb"}));
const origin = process.env.OM_ORIGIN ?? "http://localhost:5173";
const token = () => randomBytes(32).toString("base64url");
type Pending = { resolve: (v: unknown)=>void; reject: (e: Error)=>void; timer: NodeJS.Timeout };
type Session = { socket: WebSocket; code: string; expires: number; access?: string; pending: Map<string, Pending> };
const sessions = new Set<Session>();
const wss = new WebSocketServer({noServer:true,maxPayload:32768});
app.get("/health", (_req,res)=>{res.json({status:"ok",mode:"local-prototype"});});
const http = app.listen(8787,"127.0.0.1",()=>{
  console.log("OM MCP listening on http://127.0.0.1:8787");
  console.log("MCP endpoint: http://127.0.0.1:8787/mcp");
  console.log("Health check: http://127.0.0.1:8787/health");
  console.log("Waiting for browser pairing. Local prototype only.");
});
http.on("upgrade",(req,socket,head)=>{
  if(req.url!=="/browser" || req.headers.origin!==origin || sessions.size>=32){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws));
});
function revoke(s: Session){
  if(!sessions.delete(s))return;
  for(const p of s.pending.values()){clearTimeout(p.timer);p.reject(new Error("Disconnected"));}
  s.pending.clear();s.socket.close();
}
wss.on("connection",socket=>{
  const s:Session={socket,code:token(),expires:Date.now()+120000,pending:new Map()};
  sessions.add(s);
  socket.send(JSON.stringify({type:"pairing",code:s.code,expiresIn:120}));
  const expiry=setTimeout(()=>{if(!s.access)revoke(s);},120000);
  socket.on("close",()=>{clearTimeout(expiry);revoke(s);});
  socket.on("error",()=>revoke(s));
  socket.on("message",raw=>{
    try{
      const m=JSON.parse(raw.toString());
      if(m.type==="revoke"){revoke(s);return;}
      if(m.type!=="result" || typeof m.id!=="string")return;
      const p=s.pending.get(m.id);if(!p)return;
      s.pending.delete(m.id);clearTimeout(p.timer);
      if(m.ok===true)p.resolve(m.value);else p.reject(new Error("Browser rejected command"));
    }catch{revoke(s);}
  });
});
app.post("/pair",(req,res)=>{
  const code=req.body?.code;
  const s=typeof code==="string" && [...sessions].find(x=>!x.access && x.expires>Date.now() && x.code===code);
  if(!s){res.sendStatus(401);return;}
  s.access=token();s.code="";
  res.set("Cache-Control","no-store").json({access_token:s.access,token_type:"Bearer"});
});
function forward(s:Session,command:string,args:unknown):Promise<unknown>{
  if(!sessions.has(s)||s.socket.readyState!==WebSocket.OPEN||s.pending.size>=4)return Promise.reject(new Error("Session unavailable"));
  return new Promise((resolve,reject)=>{
    const id=randomUUID();
    const timer=setTimeout(()=>{s.pending.delete(id);reject(new Error("Browser timeout; outcome unknown"));},10000);
    s.pending.set(id,{resolve,reject,timer});
    s.socket.send(JSON.stringify({type:"command",id,command,args}),error=>{
      if(error){clearTimeout(timer);s.pending.delete(id);reject(error);}
    });
  });
}
app.post("/mcp",async(req,res)=>{
  const s=[...sessions].find(x=>x.access && req.headers.authorization==="Bearer "+x.access);
  if(!s){res.sendStatus(401);return;}
  const server=new McpServer({name:"om-mcp",version:"0.0.1"});
  const invoke=async(command:string,args:unknown)=>{
    try{return {content:[{type:"text" as const,text:JSON.stringify(await forward(s,command,args))??"null"}]};}
    catch{return {isError:true,content:[{type:"text" as const,text:"Command failed or timed out; do not retry mutations automatically."}]};}
  };
  server.registerTool("create_cube",{description:"Request cube creation in paired browser",inputSchema:{name:z.string().min(1).max(128)}},args=>invoke("create_cube",args));
  server.registerTool("read_value",{description:"Request a value from paired browser",inputSchema:{cube:z.string().min(1).max(128),coordinates:z.array(z.string().max(128)).max(16)}},args=>invoke("read_value",args));
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on("close",()=>{void server.close();});
  try{await server.connect(transport);await transport.handleRequest(req,res,req.body);}
  catch{if(!res.headersSent)res.sendStatus(500);}
});
app.get("/mcp",(_req,res)=>{res.sendStatus(405);});
app.delete("/mcp",(_req,res)=>{res.sendStatus(405);});
