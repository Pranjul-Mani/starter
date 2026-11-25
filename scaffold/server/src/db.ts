import { MongoClient } from 'mongodb';
import { config } from './config.ts';

let connection: Promise<MongoClient> | undefined;

export async function getDb() {
  connection ??= new MongoClient(config.mongoUrl).connect().catch(error => {
    connection = undefined;
    throw error;
  });
  return (await connection).db();
}
