import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionActionSchema,
  sessionActionApplySchema,
  sessionActionEndpointDescriptors,
} from "./session-actions.js";
void test("session action schemas reject broad edits and numeric abuse", () => {
  assert.equal(
    sessionActionSchema.safeParse({
      kind: "actor.hp",
      sceneId: "s",
      targetId: "a",
      value: 5,
      changes: { ownership: { default: 3 } },
    }).success,
    false,
  );
  assert.equal(
    sessionActionSchema.safeParse({
      kind: "token.position",
      sceneId: "s",
      targetId: "t",
      x: Infinity,
      y: 0,
    }).success,
    false,
  );
  assert.equal(
    sessionActionSchema.safeParse({ kind: "chat.post", text: "<img src=x>" }).success,
    false,
  );
  assert.equal(
    sessionActionApplySchema.safeParse({
      worldId: "w",
      requestingUserId: "gm",
      action: { kind: "door.state", sceneId: "s", targetId: "d", value: 1 },
      expectedState: { ds: 0 },
      correlationId: "c",
      idempotencyKey: "k",
    }).success,
    true,
  );
  assert.deepEqual(
    sessionActionEndpointDescriptors.map((d) => d.name),
    ["foundry_get_session_action_state", "foundry_apply_session_action", "foundry_core_action_confirmed", "foundry_set_token_light", "foundry_core_state", "foundry_get_token_light"],
  );
});

import type { EndpointContext } from "./types.js";
const lightEndpoint = sessionActionEndpointDescriptors.find(d => d.name === "foundry_set_token_light")!;
const coreEndpoint = sessionActionEndpointDescriptors.find(d => d.name === "foundry_core_action_confirmed")!;
const lightInput = (requestId="light-one") => ({worldId:"world",userId:"gm",requestId,correlationId:requestId,sceneId:"scene",tokenId:"token",light:{bright:20,dim:40,color:"#ff8800",alpha:0.4}});
function lightFixture({connected=true,gm=true,active=true,world="world",mismatch=false,receiptFailure=false,reconnectDuringReceipt=false}:{connected?:boolean;gm?:boolean;active?:boolean;world?:string;mismatch?:boolean;receiptFailure?:boolean;reconnectDuringReceipt?:boolean}={}) {
  let generation=1,mutations=0;
  const calls:string[]=[];
  const client={getCapabilityReport:()=>({clients:connected?[{userId:"gm",lane:gm?"gm":"player",isGM:gm,optedIn:true,clientId:"gm-client",connectedAt:generation}]:[]}),call:async(command:string,args:any)=>{
    calls.push(command);
    if(command==="status")return {worldId:world,userId:"gm"};
    if(command==="user")return {isGM:gm,active};
    mutations++;
    if(reconnectDuringReceipt)generation++;
    return {worldId:args.worldId,correlationId:args.correlationId,schemaVersion:args.schemaVersion,action:args.action,outcome:receiptFailure?"failure":"confirmed",mutated:!receiptFailure,state:receiptFailure?null:{light:{...args.action.light,dim:mismatch?99:args.action.light.dim,animation:{type:"pulse"},angle:270}}};
  }};
  return {context:{foundryClient:client} as unknown as EndpointContext,calls,get mutations(){return mutations;},reconnect:()=>{generation++;}};
}
void test("dedicated token light schema is bounded strict and shared with the core action family",()=>{
  assert.equal(lightEndpoint.path,"/session-actions/token/light");
  assert.ok(lightEndpoint.description.includes("scene distance units"));
  assert.ok(lightEndpoint.description.includes("vision, fog and walls"));
  const good=lightInput();assert.equal(lightEndpoint.inputSchema!.safeParse(good).success,true);
  for(const light of [{bright:-1,dim:40},{bright:0,dim:10001},{bright:NaN,dim:40},{bright:0,dim:Infinity},{bright:0,dim:20,alpha:1.1},{bright:0,dim:20,color:"red"},{bright:0,dim:20,animation:{type:"pulse"}}])assert.equal(lightEndpoint.inputSchema!.safeParse({...good,light}).success,false);
  assert.equal(lightEndpoint.inputSchema!.safeParse({...good,origin:"arbitrary"}).success,false);
  assert.equal(sessionActionSchema.safeParse({kind:"token.light",sceneId:"scene",targetId:"token",light:{bright:0,dim:0,color:null,alpha:0}}).success,true);
});
void test("GM generation change during token light acknowledgement is uncertain and fences shared lane",async()=>{
  const f=lightFixture({reconnectDuringReceipt:true});
  assert.equal((await lightEndpoint.handler(lightInput(),f.context)).outcome,"uncertain");
  assert.equal((await lightEndpoint.handler(lightInput("after-reconnect"),f.context)).outcome,"failure");
  assert.equal(f.mutations,1);
});
void test("dedicated token light authorization and native refusal cannot confirm a mutation",async()=>{
  for(const options of [{connected:false},{gm:false},{active:false},{world:"other"}]) {
    const f=lightFixture(options);const result=await lightEndpoint.handler(lightInput(),f.context);
    assert.equal(result.outcome,"failure");assert.equal(f.mutations,0);
  }
  const f=lightFixture({receiptFailure:true});assert.equal((await lightEndpoint.handler(lightInput(),f.context)).outcome,"failure");assert.equal(f.mutations,1);
});
void test("dedicated and core token light requests share serialization and deduplication",async()=>{
  const f=lightFixture(),input=lightEndpoint.inputSchema!.parse(lightInput());
  const core=coreEndpoint.inputSchema!.parse({worldId:input.worldId,userId:input.userId,requestId:input.requestId,correlationId:input.correlationId,origin:"ai-dm",schemaVersion:"core-actions-v1",action:{kind:"token.light",sceneId:input.sceneId,targetId:input.tokenId,light:input.light}});
  const results=await Promise.all([lightEndpoint.handler(input,f.context),coreEndpoint.handler(core,f.context)]);
  assert.ok(results.every(r=>r.outcome==="confirmed"));assert.equal(f.mutations,1);assert.equal(f.calls.filter(v=>v==="coreActionConfirmed").length,1);
  assert.equal((await lightEndpoint.handler({...input,light:{bright:0,dim:0}},f.context)).outcome,"failure");assert.equal(f.mutations,1);
  f.reconnect();assert.equal((await coreEndpoint.handler(core,f.context)).outcome,"failure");assert.equal(f.mutations,1);
});
void test("authoritative light patch mismatch fences subsequent mutation on the core lane",async()=>{
  const f=lightFixture({mismatch:true});assert.equal((await lightEndpoint.handler(lightInput(),f.context)).outcome,"uncertain");
  assert.equal((await coreEndpoint.handler({worldId:"world",userId:"gm",requestId:"other",correlationId:"other",origin:"ai-dm",schemaVersion:"core-actions-v1",action:{kind:"door.state",sceneId:"scene",targetId:"door",value:1}},f.context)).outcome,"failure");assert.equal(f.mutations,1);
});
void test("native radius precision rejects before dispatch and color normalization keeps canonical dedup",async()=>{
  const f=lightFixture();
  for(const radius of [10.123,0.001,20.010000000000005]) {
    assert.throws(()=>lightEndpoint.inputSchema!.parse({...lightInput(),light:{bright:radius,dim:40}}));
    assert.throws(()=>coreEndpoint.inputSchema!.parse({worldId:"world",userId:"gm",requestId:"bad",correlationId:"bad",origin:"ai-dm",schemaVersion:"core-actions-v1",action:{kind:"token.light",sceneId:"scene",targetId:"token",light:{bright:radius,dim:40}}}));
  }
  assert.equal(f.mutations,0);
  const input=lightEndpoint.inputSchema!.parse({...lightInput(),light:{bright:10.12,dim:40.29,color:"#ABCDEF",alpha:0.123456}});
  assert.equal(input.light.color,"#abcdef");assert.equal(input.light.alpha,0.123456);
  const core=coreEndpoint.inputSchema!.parse({worldId:input.worldId,userId:input.userId,requestId:input.requestId,correlationId:input.correlationId,origin:"ai-dm",schemaVersion:"core-actions-v1",action:{kind:"token.light",sceneId:input.sceneId,targetId:input.tokenId,light:{...input.light,color:"#abcdef"}}});
  assert.equal((await lightEndpoint.handler(input,f.context)).outcome,"confirmed");
  assert.equal((await coreEndpoint.handler(core,f.context)).outcome,"confirmed");assert.equal(f.mutations,1);
});


void test("optional light fields preserve the patch and empty light is rejected",()=>{
 assert.equal(lightEndpoint.inputSchema!.safeParse({...lightInput(),light:{alpha:0.1}}).success,true);
 assert.equal(lightEndpoint.inputSchema!.safeParse({...lightInput(),light:{dim:20}}).success,true);
 assert.equal(lightEndpoint.inputSchema!.safeParse({...lightInput(),light:{}}).success,false);
});
void test("targeted token emission read selects exact GM and rejects malformed or drifting acknowledgement",async()=>{
 const endpoint=sessionActionEndpointDescriptors.find(d=>d.name==="foundry_get_token_light")!;
 const input={worldId:'world',userId:'gm',sceneId:'scene',tokenId:'token'};
 const client:any={userId:'gm',lane:'gm',isGM:true,optedIn:true,clientId:'gm-client',connectedAt:1};
 let mismatch=false,drift=false;
 const calls:any[]=[];
 const context={foundryClient:{getCapabilityReport:()=>({clients:[client]}),call:async(command:any,args:any,options:any)=>{
  calls.push({command,args,options});if(drift)client.connectedAt++;
  return {...args,tokenId:mismatch?'other':args.tokenId,scope:'placed-token',units:'ft',light:{bright:10,dim:20}};
 }}} as unknown as EndpointContext;
 const result=await endpoint.handler(input,context);assert.equal(result.scope,'placed-token');
 assert.equal(calls[0].command,'tokenLightRead');assert.equal(calls[0].options.clientId,'gm-client');
 mismatch=true;await assert.rejects(endpoint.handler(input,context),/readback/);
 mismatch=false;drift=true;await assert.rejects(endpoint.handler(input,context),/authority changed/);
});

void test("MCP schema accepts bright-only emission and partial bright-only rendering edits",()=>{
 assert.equal(lightEndpoint.inputSchema!.safeParse({...lightInput(),light:{bright:20,dim:0}}).success,true);
 assert.equal(sessionActionSchema.safeParse({kind:'token.light',sceneId:'scene',targetId:'token',light:{bright:20,dim:0}}).success,true);
 assert.equal(lightEndpoint.inputSchema!.safeParse({...lightInput(),light:{alpha:0.2}}).success,true);
});
