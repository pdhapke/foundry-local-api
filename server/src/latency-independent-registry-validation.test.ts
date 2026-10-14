import assert from 'node:assert/strict';import test from 'node:test';import {z} from 'zod';import type{McpServer}from '@modelcontextprotocol/sdk/server/mcp.js';import {registerMcpTools}from './endpoints/registry.js';import type{FoundryClient}from './bridge/foundry-client.js';import type{AnyEndpointDescriptor}from './endpoints/types.js';import{currentTraceId}from './latency-trace.js';
void test('independent optional telemetry metadata preserves schema and no-input callbacks',async()=>{
 const callbacks=new Map<string,(...args:unknown[])=>Promise<unknown>>();const server={registerTool:(name:string,_config:unknown,cb:(...args:unknown[])=>Promise<unknown>)=>callbacks.set(name,cb)} as unknown as McpServer;
 const descriptors:AnyEndpointDescriptor[]=[{name:'latency_input',description:'fixture',inputSchema:z.object({id:z.string()}),handler:(input:unknown)=>({input,trace:currentTraceId()??null})},{name:'latency_empty',description:'fixture',handler:()=>({trace:currentTraceId()??null})}];registerMcpTools(server,descriptors,{}as FoundryClient);
 const input=callbacks.get('latency_input')!,empty=callbacks.get('latency_empty')!;
 const text=(value:unknown)=>JSON.parse((value as {content:{text:string}[]}).content[0]!.text);
 assert.deepEqual(text(await input({id:'ok'})),{input:{id:'ok'},trace:null});assert.deepEqual(text(await empty()),{trace:null});
 const id='12345678-1234-1234-1234-123456789abc';assert.deepEqual(text(await empty({_meta:{'foundry-ai-dungeon-master/trace-id':id}})),{trace:id});await assert.rejects(input({bad:'malformed'}),/Invalid input/);
});


