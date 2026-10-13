import type { APIGatewayProxyHandlerV2, APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import Stripe from 'stripe';
import { piece } from '../shared/catalog';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = process.env.TABLE_NAME!;
const key = `PIECE#${piece.id}`;
const reply = (statusCode:number, data:unknown) => ({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(data)});
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
export const normalizeEmail = (value:unknown) => typeof value==='string' ? value.trim().toLowerCase() : '';
export const validEmail = (email:string) => email.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const conditional = (error:unknown) => error instanceof Error && error.name==='ConditionalCheckFailedException';
let secrets:Promise<{secretKey:string;webhookSecret:string}>|undefined;
async function stripeConfig() {
 if(!process.env.STRIPE_SECRET_ARN) throw Error('Payments are not configured');
 secrets ??= new SecretsManagerClient({}).send(new GetSecretValueCommand({SecretId:process.env.STRIPE_SECRET_ARN})).then(r=>JSON.parse(r.SecretString!)).catch(e=>{secrets=undefined;throw e;});
 return secrets;
}
async function inventory() { return (await db.send(new GetCommand({TableName:table,Key:{pk:key},ConsistentRead:true}))).Item; }
async function rateLimit(event:APIGatewayProxyEventV2) {
 const hour=Math.floor(Date.now()/3600000);const ip=event.requestContext.http.sourceIp;
 // Per-hour salted hashes avoid retaining raw IP addresses.
 const pk=`RATE#${hash(`${hour}:${ip}`)}`;
 try {await db.send(new UpdateCommand({TableName:table,Key:{pk},UpdateExpression:'SET expiresAt = :ttl ADD hits :one',ConditionExpression:'attribute_not_exists(hits) OR hits < :max',ExpressionAttributeValues:{':ttl':(hour+2)*3600,':one':1,':max':12}}));return true;}catch(e){if(conditional(e))return false;throw e;}
}
export const handler:APIGatewayProxyHandlerV2 = async event => {
 const path=event.rawPath;
 try {
  if(event.requestContext.http.method==='GET'&&path==='/catalog') {
   const stock=await inventory();const enabled=process.env.CHECKOUT_ENABLED==='true'&&!!process.env.STRIPE_SECRET_ARN&&!!stock?.size;
   return reply(200,{...piece,size:stock?.size||null,status:enabled?(stock?.status||'coming-soon'):'coming-soon'});
  }
  if(event.requestContext.http.method==='POST'&&path==='/stripe/webhook') return await webhook(event);
  const allowedOrigins=(process.env.ALLOWED_ORIGINS||'').split(',');
  if(!allowedOrigins.includes(event.headers.origin||''))return reply(403,{message:'This request is not allowed.'});
  if(!await rateLimit(event))return reply(429,{message:'A few too many requests. Please try again later.'});
  let body:Record<string,unknown>;
  try {if(!event.body||event.body.length>4096)throw Error();body=JSON.parse(event.body);if(!body||Array.isArray(body)||typeof body!=='object')throw Error();}catch{return reply(400,{message:'Please check your details.'});}
  if(path==='/waitlist'||path==='/waitlist/remove') {
   if(body.website)return reply(200,{ok:true});
   const email=normalizeEmail(body.email);if(!validEmail(email))return reply(400,{message:'Please enter a valid email address.'});
   if(path==='/waitlist/remove') {await db.send(new DeleteCommand({TableName:table,Key:{pk:`EMAIL#${hash(email)}`}}));return reply(200,{ok:true});}
   if(body.consent!==true)return reply(400,{message:'Please agree to receive launch emails.'});
   await db.send(new PutCommand({TableName:table,Item:{pk:`EMAIL#${hash(email)}`,email,consentVersion:'launch-v1',consentAt:new Date().toISOString(),expiresAt:Math.floor(Date.now()/1000)+180*86400}}));
   return reply(200,{ok:true});
  }
  if(path==='/checkout') {
   if(process.env.CHECKOUT_ENABLED!=='true'||!process.env.STRIPE_SECRET_ARN)return reply(409,{message:'This piece is coming soon. Join the guest list for first access.'});
   if(body.productId!==piece.id)return reply(400,{message:'Unknown piece.'});
   const stock=await inventory();if(!stock?.size)return reply(409,{message:'This piece is not ready for release.'});
   const config=await stripeConfig(); const stripe=new Stripe(config.secretKey);
   const reservation=randomUUID(); const now=Math.floor(Date.now()/1000);
   try {await db.send(new UpdateCommand({TableName:table,Key:{pk:key},UpdateExpression:'SET #s=:reserved, reservation=:r, reservedAt=:now',ConditionExpression:'#s=:available AND #size=:size',ExpressionAttributeNames:{'#s':'status','#size':'size'},ExpressionAttributeValues:{':reserved':'reserved',':available':'available',':r':reservation,':now':now,':size':stock.size}}));}
   catch(e){if(conditional(e))return reply(409,{message:'Someone got there first. This piece is reserved or collected.'});throw e;}
   // Keep uncertain reservations locked. Never unlock on a network error: Stripe may have created a session.
   const session=await stripe.checkout.sessions.create({mode:'payment',allowed_payment_method_types:['card','twint'],line_items:[{price_data:{currency:piece.currency,unit_amount:piece.price,product_data:{name:`HEWGE — ${piece.name}`,description:`Artist-signed silk. One of one. Size ${stock.size}.`,images:[`${process.env.SITE_URL}${piece.image}`]}},quantity:1}],metadata:{productId:piece.id,reservation},client_reference_id:reservation,expires_at:now+31*60,success_url:`${process.env.SITE_URL}/?checkout=success`,cancel_url:`${process.env.SITE_URL}/?checkout=cancelled`,shipping_address_collection:{allowed_countries:['CH']},billing_address_collection:'required',consent_collection:{terms_of_service:'required'},custom_text:{terms_of_service_acceptance:{message:`I agree to the [Hewge terms](${process.env.TERMS_URL}).`}}},{idempotencyKey:reservation});
   await db.send(new UpdateCommand({TableName:table,Key:{pk:key},UpdateExpression:'SET sessionId=:session',ConditionExpression:'reservation=:r',ExpressionAttributeValues:{':session':session.id,':r':reservation}}));
   return reply(200,{url:session.url});
  }
  return reply(404,{message:'Not found.'});
 } catch(error) {
  console.error(JSON.stringify({event:'request_failed',path,error:error instanceof Error?error.name:'UnknownError'}));
  return reply(503,{message:'Temporarily unavailable. Please try again shortly.'});
 }
};
async function webhook(event:APIGatewayProxyEventV2) {
 const config=await stripeConfig();const stripe=new Stripe(config.secretKey);let stripeEvent:Stripe.Event;
 try {stripeEvent=stripe.webhooks.constructEvent(event.isBase64Encoded?Buffer.from(event.body||'','base64'):event.body||'',event.headers['stripe-signature']||'',config.webhookSecret);}catch{return reply(400,{message:'Invalid signature.'});}
 if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired'].includes(stripeEvent.type))return reply(200,{received:true});
 const session=stripeEvent.data.object as Stripe.Checkout.Session;
 if(session.metadata?.productId!==piece.id||!session.metadata.reservation)return reply(200,{received:true});
 const paid=session.payment_status==='paid'; const expired=stripeEvent.type==='checkout.session.expired';
 if(!paid&&!expired)return reply(200,{received:true});
 if(paid&&(session.amount_total!==piece.price||session.currency!==piece.currency)) {console.error(JSON.stringify({event:'payment_amount_mismatch',sessionId:session.id}));return reply(422,{message:'Amount mismatch.'});}
 try {
  await db.send(new UpdateCommand({TableName:table,Key:{pk:key},UpdateExpression:paid?'SET #s=:next, sessionId=:session, soldAt=:time REMOVE reservation, reservedAt':'SET #s=:next REMOVE reservation, reservedAt, sessionId',ConditionExpression:'#s=:reserved AND reservation=:r',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':next':paid?'sold':'available',':reserved':'reserved',':r':session.metadata.reservation,...(paid?{':session':session.id,':time':new Date().toISOString()}:{})}}));
 }catch(e){if(!conditional(e))throw e; // Duplicate/out-of-order events cannot release a different reservation.
  const current=await inventory();if(paid&&!(current?.status==='sold'&&current?.sessionId===session.id)){console.error(JSON.stringify({event:'paid_inventory_conflict',sessionId:session.id}));return reply(409,{message:'Inventory reconciliation required.'});}
 }
 return reply(200,{received:true});
}
