import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const response = await ai.models.generateContent({
  model: 'gemini-3.5-flash',
  //model :'gemini-3.8-flashe',
  contents: 'Hello'
});

console.log(response.text);