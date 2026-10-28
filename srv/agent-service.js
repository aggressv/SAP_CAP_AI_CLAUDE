import cds from '@sap/cds';
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

export default cds.service.impl(function () {

  this.on('AskAI', async (req) => {

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: req.data.prompt
    });

    return response.text;
  });

});