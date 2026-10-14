import assert from 'node:assert/strict';import test from 'node:test';
import {dispatch,registerCommand,registerTimedCommand,unregisterCommand} from './command-registry.js';
void test('independent legacy second parameter default remains scheduler and timed registration isolated',async()=>{
 const stages:string[]=[];const timing={record:(stage:string)=>stages.push(stage)};
 registerCommand('latency-independent-legacy',(value:unknown,scheduler:unknown='default-scheduler')=>({value,scheduler}));
 registerTimedCommand('latency-independent-timed',(value:unknown,t)=>{t?.record('unit',1);return value;});
 try{const legacy=await dispatch({id:'legacy',type:'latency-independent-legacy',payload:1},timing);assert.deepEqual(legacy,{id:'legacy',ok:true,result:{value:1,scheduler:'default-scheduler'}});assert.equal(stages.length,0);await dispatch({id:'timed',type:'latency-independent-timed',payload:2},timing);assert.deepEqual(stages,['unit']);
 registerCommand('latency-independent-timed',(value:unknown)=>value);await dispatch({id:'replaced',type:'latency-independent-timed',payload:3},timing);assert.deepEqual(stages,['unit']);
 }finally{unregisterCommand('latency-independent-legacy');unregisterCommand('latency-independent-timed');}
});
