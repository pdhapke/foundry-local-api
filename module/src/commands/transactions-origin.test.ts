import assert from "node:assert/strict";
import test from "node:test";
import type { TransactionManifest } from "@foundry-local-api/shared";
import { executeAtomicTransaction, transactionRevision } from "./transactions.js";

void test("validated transaction executor marks forward and compensation hooks with one correlation (mocked Foundry documents)",async()=>{
  const calls:Array<{operation:string;options:Record<string,unknown>|undefined}>=[];
  const journals=new Map<string,Doc>();
  class Doc {
    constructor(readonly id:string,private data:Record<string,unknown>){}
    toObject(){return structuredClone(this.data);}
    canUserModify(){return true;}
    update(changes:Record<string,unknown>,options?:Record<string,unknown>){calls.push({operation:"update",options});this.data=options?.["diff"]===false?structuredClone(changes):{...this.data,...changes};return Promise.resolve(this);}
    delete(options?:Record<string,unknown>){calls.push({operation:"delete",options});journals.delete(this.id);return Promise.resolve(this);}
  }
  const klass={canUserCreate:()=>true,metadata:{embedded:{}},create:(data:Record<string,unknown>,options?:Record<string,unknown>)=>{calls.push({operation:"create",options});if(data["name"]==="fail")return Promise.reject(new Error("fixture write failure"));const doc=new Doc(String(data["_id"]),data);journals.set(doc.id,doc);return Promise.resolve(doc);}};
  Object.assign(globalThis,{CONFIG:{JournalEntry:{documentClass:klass}},game:{collections:new Map([["JournalEntry",journals]]),user:{id:"gm",isGM:true},world:{id:"w"},release:{version:"14.368"},system:{id:"dnd5e",version:"6"},modules:new Map([["foundry-local-api",{version:"0.1.0"}]])}});
  const manifest:TransactionManifest={mode:"atomic",rollbackPolicy:"strict",worldId:"w",correlationId:"aidm-origin-fixture",idempotencyKey:"origin-fixture",operations:[{operationId:"create",kind:"document.create",documentType:"JournalEntry",data:{_id:"OriginCreate0001",name:"safe",aiDmOrigin:"forged"}},{operationId:"fail",kind:"document.create",documentType:"JournalEntry",data:{_id:"OriginFails00001",name:"fail"}}]};
  await assert.rejects(executeAtomicTransaction(manifest),(error:unknown)=>{assert.match((error as Error).message,/Transaction failed/);return true;});assert.equal(journals.size,0);assert.ok(calls.some(call=>call.operation==="delete"));
  for(const call of calls){assert.equal(call.options?.["correlationId"],manifest.correlationId);assert.deepEqual(call.options?.["foundryLocalApiOrigin"],{source:"foundry-local-api.transaction",phase:call.operation==="delete"?"compensate":"apply",correlationId:manifest.correlationId});assert.equal(call.options?.["aiDmOrigin"],undefined);}
  calls.length=0;const before={_id:"existing",name:"before"};journals.set("existing",new Doc("existing",before));manifest.operations=[{operationId:"update",kind:"document.update",documentType:"JournalEntry",documentId:"existing",expectedRevision:await transactionRevision(before),changes:{name:"after"}},{operationId:"fail",kind:"document.create",documentType:"JournalEntry",data:{_id:"OriginFails00001",name:"fail"}}];
  await assert.rejects(executeAtomicTransaction(manifest));assert.equal(journals.get("existing")!.toObject()["name"],"before");const updates=calls.filter(call=>call.operation==="update");assert.deepEqual(updates.map(call=>(call.options?.["foundryLocalApiOrigin"] as {phase:string}).phase),["apply","compensate"]);
});
