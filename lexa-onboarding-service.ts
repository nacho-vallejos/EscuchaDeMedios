/**
 * LEXA - Servicio de Onboarding Conversacional
 * Sistema de captación de casos laborales vía WhatsApp + IA
 * 
 * Stack: Node.js + TypeScript + OpenAI GPT-4 + Twilio WhatsApp API
 */

import { OpenAI } from 'openai';
import twilio from 'twilio';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

// ============================================
// TIPOS Y INTERFACES
// ============================================

interface WhatsAppMessage {
  from: string;
  to: string;
  body: string;
  mediaUrl?: string;
  mediaContentType?: string;
  messageId: string;
}

interface ExtractedCase {
  tipoReclamo: 'despido' | 'accidente' | 'acoso' | 'aportes' | 'otro';
  relato: string;
  fechaHechos?: string;
  antiguedad?: number; // años
  salarioBruto?: number; // ARS
  horasExtras?: boolean;
  liquidacionRecibida?: boolean;
  montoLiquidacion?: number;
  documentosAdjuntos: string[];
  viabilidadLegal: {
    viable: boolean;
    confianza: number; // 0-100
    razones: string[];
    riesgos: string[];
  };
  montoEstimado: {
    min: number;
    max: number;
    concepto: string[];
  };
}

interface OnboardingSession {
  phoneNumber: string;
  stage: 'inicio' | 'recolectando_datos' | 'validando' | 'completado';
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }>;
  extractedData: Partial<ExtractedCase>;
  attachments: string[];
}

// ============================================
// SERVICIO PRINCIPAL
// ============================================

export class WhatsAppOnboardingService {
  private openai: OpenAI;
  private twilioClient: twilio.Twilio;
  private prisma: PrismaClient;
  private sessions: Map<string, OnboardingSession>;

  constructor(
    openAiApiKey: string,
    twilioAccountSid: string,
    twilioAuthToken: string,
    twilioWhatsAppNumber: string
  ) {
    this.openai = new OpenAI({ apiKey: openAiApiKey });
    this.twilioClient = twilio(twilioAccountSid, twilioAuthToken);
    this.prisma = new PrismaClient();
    this.sessions = new Map();
  }

  /**
   * Punto de entrada: procesa mensaje entrante de WhatsApp
   */
  async processIncomingMessage(message: WhatsAppMessage): Promise<void> {
    const session = this.getOrCreateSession(message.from);

    // 1. Guardar mensaje del usuario
    session.messages.push({
      role: 'user',
      content: message.body,
      timestamp: new Date(),
    });

    // 2. Procesar multimedia si existe
    if (message.mediaUrl) {
      await this.processMediaAttachment(message, session);
    }

    // 3. Extraer información con IA
    const extraction = await this.extractInformationWithAI(session);
    session.extractedData = { ...session.extractedData, ...extraction };

    // 4. Generar respuesta conversacional
    const response = await this.generateConversationalResponse(session);

    // 5. Enviar respuesta por WhatsApp
    await this.sendWhatsAppMessage(message.from, response);

    // 6. Si recolectamos info suficiente, validar y crear Lead
    if (this.hasEnoughInformation(session)) {
      await this.validateAndCreateLead(session);
    }

    // 7. Guardar sesión
    this.sessions.set(message.from, session);
  }

  /**
   * Extrae información estructurada usando GPT-4
   */
  private async extractInformationWithAI(
    session: OnboardingSession
  ): Promise<Partial<ExtractedCase>> {
    const conversationHistory = session.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    const systemPrompt = `Eres un asistente legal especializado en derecho laboral argentino.
Tu objetivo es extraer información estructurada de casos laborales.

TIPOS DE RECLAMOS:
- Despido sin causa / con causa / discriminatorio
- Accidente de trabajo / enfermedad profesional
- Acoso laboral / mobbing
- Falta de registración / trabajo en negro
- Aportes previsionales no realizados
- Diferencias salariales
- Horas extras no abonadas

LEYES APLICABLES:
- Ley de Contrato de Trabajo 20.744
- Ley de Riesgos del Trabajo 24.557
- Convenios Colectivos por actividad

EXTRAE:
1. Tipo de reclamo
2. Relato completo de hechos
3. Fechas relevantes
4. Antigüedad laboral
5. Salario bruto mensual
6. Si recibió liquidación y monto
7. Documentación mencionada

Responde SOLO con un JSON válido.`;

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Conversación:\n${conversationHistory}\n\nExtrae la información en formato JSON.`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const extracted = JSON.parse(completion.choices[0].message.content || '{}');
    return extracted;
  }

  /**
   * Valida viabilidad legal del caso con IA
   */
  private async validateLegalViability(
    caseData: Partial<ExtractedCase>
  ): Promise<ExtractedCase['viabilidadLegal']> {
    const prompt = `Analiza la viabilidad legal de este caso laboral argentino:

DATOS DEL CASO:
${JSON.stringify(caseData, null, 2)}

CRITERIOS DE VIABILIDAD:
1. Prescripción: 2 años desde el despido/hecho (Art. 256 LCT)
2. Registro del vínculo laboral
3. Prueba documental disponible
4. Monto económico justifica litigio (honorarios 25% + gastos)
5. Competencia territorial (domicilio trabajador/empresa)

FACTORES DE RIESGO:
- Falta de prueba documental
- Trabajador monotributista (presunción de autonomía)
- Recibos firmados sin reservas
- Renuncia voluntaria
- Pagos en negro sin testigos

Responde con:
{
  "viable": boolean,
  "confianza": 0-100,
  "razones": ["razón 1", "razón 2"],
  "riesgos": ["riesgo 1", "riesgo 2"],
  "jurisprudencia_aplicable": ["Fallo 1", "Fallo 2"]
}`;

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content:
            'Eres un abogado laboralista senior especializado en derecho del trabajo argentino con 20 años de experiencia.',
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });

    return JSON.parse(completion.choices[0].message.content || '{}');
  }

  /**
   * Calcula monto estimado de reclamo según legislación argentina
   */
  private async calculateClaimAmount(
    caseData: Partial<ExtractedCase>
  ): Promise<ExtractedCase['montoEstimado']> {
    const { tipoReclamo, salarioBruto = 0, antiguedad = 0 } = caseData;

    let conceptos: string[] = [];
    let min = 0;
    let max = 0;

    switch (tipoReclamo) {
      case 'despido':
        // Indemnización Art. 245 LCT: 1 mes de sueldo por año de antigüedad
        const indemnizacionBase = salarioBruto * antiguedad;

        // Preaviso Art. 231 LCT: 1-2 meses según antigüedad
        const preaviso = antiguedad < 5 ? salarioBruto : salarioBruto * 2;

        // Integración mes de despido Art. 233 LCT
        const integracion = salarioBruto;

        // SAC proporcional
        const sacProporcional = (salarioBruto / 12) * 6;

        // Vacaciones no gozadas
        const vacaciones = salarioBruto * 0.5;

        min = indemnizacionBase + preaviso + integracion + sacProporcional + vacaciones;
        max = min * 1.3; // Considerando aumentos salariales no registrados

        conceptos = [
          `Indemnización Art. 245: $${indemnizacionBase.toLocaleString('es-AR')}`,
          `Preaviso: $${preaviso.toLocaleString('es-AR')}`,
          `Integración: $${integracion.toLocaleString('es-AR')}`,
          `SAC Proporcional: $${sacProporcional.toLocaleString('es-AR')}`,
          `Vacaciones: $${vacaciones.toLocaleString('es-AR')}`,
        ];
        break;

      case 'accidente':
        // Ley 24.557 - Riesgos del Trabajo
        // Incapacidad Laboral Permanente (ILP)
        // Asumimos ILP 30% como promedio
        const ilp = 30;
        const valorPunto = 200000; // Valor orientativo 2026
        const indemnizacionArt = (ilp * valorPunto * 65) / 100;

        // Acción Civil (vía optativa Art. 1072 Cód. Civil)
        const danoMoral = salarioBruto * 36; // 3 años de salario
        const lucroDesante = salarioBruto * 24; // 2 años

        min = indemnizacionArt;
        max = indemnizacionArt + danoMoral + lucroDesante;

        conceptos = [
          `Indemnización ART (ILP ${ilp}%): $${indemnizacionArt.toLocaleString('es-AR')}`,
          `Daño Moral (optativo): $${danoMoral.toLocaleString('es-AR')}`,
          `Lucro Cesante (optativo): $${lucroDesante.toLocaleString('es-AR')}`,
        ];
        break;

      case 'aportes':
        // Aportes no realizados: 11% empleado + 17% empleador = 28% sobre salario
        const mesesSinAportes = antiguedad * 12;
        const aportesMensuales = salarioBruto * 0.28;
        min = aportesMensuales * mesesSinAportes;
        max = min * 1.5; // Con intereses y punitorios

        conceptos = [
          `Aportes previsionales impagos: $${min.toLocaleString('es-AR')}`,
          `Intereses Art. 768 CCyC: $${(max - min).toLocaleString('es-AR')}`,
        ];
        break;

      default:
        min = salarioBruto * 6;
        max = salarioBruto * 12;
        conceptos = ['Estimación genérica'];
    }

    return { min, max, concepto: conceptos };
  }

  /**
   * Genera respuesta conversacional con IA
   */
  private async generateConversationalResponse(
    session: OnboardingSession
  ): Promise<string> {
    const systemPrompt = `Eres LEXA, un asistente virtual empático y profesional de un estudio jurídico laboral argentino.

OBJETIVOS:
1. Recolectar información clave del caso de forma conversacional
2. Generar confianza y contención al trabajador
3. Obtener: tipo de reclamo, antigüedad, salario, fecha de despido/accidente, si tiene recibos

TONO:
- Empático pero profesional
- Claro y conciso (WhatsApp)
- Usa emojis moderadamente: ⚖️ 📄 ✅ ⏰
- Tutear al usuario
- Mensajes cortos (máximo 3 líneas)

FLUJO:
1ra interacción → Saludar y preguntar qué pasó
2da interacción → Pedir detalles (fechas, salario)
3ra interacción → Consultar documentación
4ta interacción → Informar próximos pasos

NO PROMETAS resultados específicos.
NO des asesoramiento legal completo (eso es del abogado).`;

    const messages = session.messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      temperature: 0.7,
      max_tokens: 150,
    });

    const response = completion.choices[0].message.content || 'Entiendo, continúa...';
    
    // Guardar respuesta en sesión
    session.messages.push({
      role: 'assistant',
      content: response,
      timestamp: new Date(),
    });

    return response;
  }

  /**
   * Procesa archivos multimedia (PDF, audio, imágenes)
   */
  private async processMediaAttachment(
    message: WhatsAppMessage,
    session: OnboardingSession
  ): Promise<void> {
    const { mediaUrl, mediaContentType } = message;

    if (!mediaUrl) return;

    // 1. Descargar archivo
    const mediaBuffer = await this.downloadMedia(mediaUrl);
    const fileName = `${session.phoneNumber}_${Date.now()}${this.getFileExtension(
      mediaContentType!
    )}`;
    const filePath = path.join('/tmp/lexa-attachments', fileName);

    // Crear directorio si no existe
    if (!fs.existsSync('/tmp/lexa-attachments')) {
      fs.mkdirSync('/tmp/lexa-attachments', { recursive: true });
    }

    fs.writeFileSync(filePath, mediaBuffer);
    session.attachments.push(filePath);

    // 2. Procesar según tipo
    if (mediaContentType?.includes('audio')) {
      await this.transcribeAudio(filePath, session);
    } else if (mediaContentType?.includes('image')) {
      await this.analyzeImage(filePath, session);
    } else if (mediaContentType?.includes('pdf')) {
      await this.extractTextFromPDF(filePath, session);
    }
  }

  /**
   * Transcribe audio a texto con Whisper
   */
  private async transcribeAudio(
    filePath: string,
    session: OnboardingSession
  ): Promise<void> {
    const transcription = await this.openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      language: 'es',
    });

    // Agregar transcripción como mensaje del usuario
    session.messages.push({
      role: 'user',
      content: `[AUDIO TRANSCRITO]: ${transcription.text}`,
      timestamp: new Date(),
    });
  }

  /**
   * Analiza imagen con GPT-4 Vision
   */
  private async analyzeImage(
    filePath: string,
    session: OnboardingSession
  ): Promise<void> {
    const imageBase64 = fs.readFileSync(filePath, { encoding: 'base64' });

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4-vision-preview',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Describe este documento laboral. Si es un recibo de sueldo, telegrama de despido, certificado médico u otro documento legal, extrae toda la información relevante.',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
              },
            },
          ],
        },
      ],
      max_tokens: 500,
    });

    const analysis = response.choices[0].message.content || '';
    session.messages.push({
      role: 'user',
      content: `[ANÁLISIS DE IMAGEN]: ${analysis}`,
      timestamp: new Date(),
    });
  }

  /**
   * Extrae texto de PDF
   */
  private async extractTextFromPDF(
    filePath: string,
    session: OnboardingSession
  ): Promise<void> {
    // Implementar con librería como pdf-parse
    // Por simplicidad, se asume que está implementado
    const extractedText = 'Texto extraído del PDF...'; // Placeholder
    
    session.messages.push({
      role: 'user',
      content: `[DOCUMENTO PDF]: ${extractedText}`,
      timestamp: new Date(),
    });
  }

  /**
   * Valida si tenemos info suficiente para crear Lead
   */
  private hasEnoughInformation(session: OnboardingSession): boolean {
    const { extractedData } = session;
    return !!(
      extractedData.tipoReclamo &&
      extractedData.relato &&
      extractedData.salarioBruto &&
      extractedData.antiguedad
    );
  }

  /**
   * Valida caso y crea Lead en base de datos
   */
  private async validateAndCreateLead(session: OnboardingSession): Promise<void> {
    const caseData = session.extractedData as ExtractedCase;

    // 1. Validar viabilidad legal
    const viabilidad = await this.validateLegalViability(caseData);
    caseData.viabilidadLegal = viabilidad;

    // 2. Calcular monto estimado
    const montoEstimado = await this.calculateClaimAmount(caseData);
    caseData.montoEstimado = montoEstimado;

    // 3. Crear Lead en BD
    const lead = await this.prisma.lead.create({
      data: {
        tenantId: 'default-tenant', // Obtener del contexto
        phone: session.phoneNumber,
        source: 'whatsapp',
        status: viabilidad.viable ? 'qualified' : 'rejected',
        score: viabilidad.confianza,
        sourceMetadata: {
          conversationHistory: session.messages,
          attachments: session.attachments,
        },
      },
    });

    // 4. Crear expediente digital
    const expediente = await this.prisma.case.create({
      data: {
        leadId: lead.id,
        tenantId: 'default-tenant',
        type: caseData.tipoReclamo,
        description: caseData.relato,
        status: 'intake',
        estimatedAmount: caseData.montoEstimado.max,
        metadata: {
          viabilidad: caseData.viabilidadLegal,
          calculoMonto: caseData.montoEstimado,
          datosExtraidos: caseData,
        },
      },
    });

    // 5. Enviar notificación al equipo
    await this.notifyTeam(lead, expediente, caseData);

    // 6. Informar al usuario
    const finalMessage = viabilidad.viable
      ? `✅ ¡Perfecto! Analizamos tu caso y tiene viabilidad legal.

📊 Estimación: $${caseData.montoEstimado.min.toLocaleString('es-AR')} - $${caseData.montoEstimado.max.toLocaleString('es-AR')}

⚖️ Un abogado especializado revisará tu caso en las próximas 24hs y te contactará.

📄 Tu caso fue registrado con el N° ${expediente.id.slice(0, 8).toUpperCase()}`
      : `⚠️ Revisamos tu caso y lamentablemente presenta algunos desafíos:

${viabilidad.razones.join('\n')}

De todas formas, un abogado revisará la situación para ver alternativas.`;

    await this.sendWhatsAppMessage(session.phoneNumber, finalMessage);

    // Actualizar estado de sesión
    session.stage = 'completado';
  }

  /**
   * Envía mensaje por WhatsApp (Twilio)
   */
  private async sendWhatsAppMessage(to: string, message: string): Promise<void> {
    await this.twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${to}`,
      body: message,
    });
  }

  /**
   * Notifica al equipo sobre nuevo Lead
   */
  private async notifyTeam(lead: any, expediente: any, caseData: ExtractedCase): Promise<void> {
    // Implementar notificaciones via email, Slack, etc.
    console.log('🔔 Nuevo Lead creado:', lead.id);
    console.log('📋 Expediente:', expediente.id);
    console.log('💰 Monto estimado:', caseData.montoEstimado);
  }

  /**
   * Helpers
   */
  private getOrCreateSession(phoneNumber: string): OnboardingSession {
    if (!this.sessions.has(phoneNumber)) {
      this.sessions.set(phoneNumber, {
        phoneNumber,
        stage: 'inicio',
        messages: [],
        extractedData: {},
        attachments: [],
      });
    }
    return this.sessions.get(phoneNumber)!;
  }

  private async downloadMedia(url: string): Promise<Buffer> {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  }

  private getFileExtension(contentType: string): string {
    const map: Record<string, string> = {
      'audio/ogg': '.ogg',
      'audio/mpeg': '.mp3',
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'application/pdf': '.pdf',
    };
    return map[contentType] || '.bin';
  }
}

// ============================================
// EJEMPLO DE USO
// ============================================

/*
const service = new WhatsAppOnboardingService(
  process.env.OPENAI_API_KEY!,
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
  process.env.TWILIO_WHATSAPP_NUMBER!
);

// Webhook handler para Express
app.post('/webhook/whatsapp', async (req, res) => {
  const message: WhatsAppMessage = {
    from: req.body.From.replace('whatsapp:', ''),
    to: req.body.To,
    body: req.body.Body,
    mediaUrl: req.body.MediaUrl0,
    mediaContentType: req.body.MediaContentType0,
    messageId: req.body.MessageSid,
  };

  await service.processIncomingMessage(message);
  res.sendStatus(200);
});
*/
