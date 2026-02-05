# LEXA - Sistema Dual de Legaltech + OSINT

## 🚀 Servicios Implementados

### 1. Servicio de Onboarding Conversacional (`lexa-onboarding-service.ts`)

**Características principales:**
- ✅ Integración completa con WhatsApp Business API (Twilio)
- ✅ Motor de IA con GPT-4 para extracción estructurada de datos
- ✅ Transcripción de audios con Whisper
- ✅ Análisis de imágenes con GPT-4 Vision (recibos, telegramas, certificados)
- ✅ Extracción de texto de PDFs
- ✅ Validación legal automática según Ley de Contrato de Trabajo Argentina (20.744)
- ✅ Cálculo de montos estimados por tipo de reclamo
- ✅ Creación automática de Leads y expedientes digitales

**Tipos de reclamos soportados:**
- Despido sin causa / con causa / discriminatorio
- Accidente de trabajo / enfermedad profesional (Ley 24.557)
- Acoso laboral / mobbing
- Falta de registración / trabajo en negro
- Aportes previsionales no realizados
- Diferencias salariales
- Horas extras no abonadas

**Flujo conversacional:**
```
Usuario: "Me despidieron sin causa"
LEXA: "Entiendo tu situación. ¿Cuánto tiempo trabajaste ahí?"
Usuario: "5 años"
LEXA: "¿Cuál era tu salario mensual?"
Usuario: "Enviado audio: cobraba 500 mil pesos..."
LEXA: [Transcribe audio] "¿Recibiste alguna liquidación?"
Usuario: [Envía foto de telegrama de despido]
LEXA: [Analiza imagen, calcula indemnización]
      "✅ Tu caso tiene viabilidad legal.
      📊 Estimación: $2.500.000 - $3.250.000
      Un abogado te contactará en 24hs"
```

---

### 2. Algoritmo de Matching Inteligente (`lexa-matching-algorithm.ts`)

**Sistema de scoring ponderado:**
```typescript
Score Total = 
  + (Jurisdicción × 35%)
  + (Carga Operativa × 25%)
  + (Especialización × 20%)
  + (Performance Histórico × 15%)
  + (Complejidad/Experiencia × 5%)
  - Penalización por Rechazos Recientes
```

**Criterios de asignación:**

1. **Jurisdicción (35%)** - Match geográfico
   - 100 pts: Misma provincia + ciudad
   - 90 pts: Misma provincia
   - 80 pts: Fuero nacional compatible
   - 0 pts: Fuera de jurisdicción

2. **Carga Operativa (25%)** - Capacidad disponible
   - 100 pts: < 50% capacidad
   - 75 pts: 50-75% capacidad
   - 50 pts: 75-90% capacidad
   - 0 pts: Capacidad máxima alcanzada

3. **Especialización (20%)** - Experiencia en el tipo de caso
   - 70 pts: Especialista en el tipo de caso
   - 30 pts: Certificaciones específicas
   - 0 pts: Sin especialización

4. **Performance Histórico (15%)** - Métricas de rendimiento
   - Tasa de aceptación: 40% del componente
   - Tasa de éxito (casos ganados): 40%
   - Tiempo de respuesta: 20%

5. **Penalización por Rechazos**
   - -5 pts por rechazo en últimos 7 días
   - -10 pts adicionales si tasa rechazo > 30%
   - La penalización se degrada con el tiempo

**Ejemplo de output:**
```typescript
Top 3 matches:
1. Dr. Juan Pérez - Score: 92.5
   Razones: ✅ Jurisdicción exacta: Buenos Aires
            ✅ Baja carga operativa (8/15 casos)
            ✅ Especialista en despido
            ✅ Alta tasa de aceptación (91.7%)
   
2. Dra. María González - Score: 85.0
   Razones: ✅ Jurisdicción exacta: Buenos Aires
            ⚠️ Carga moderada (12/15 casos)
            ✔️ Experiencia en casos de despido
   
3. Dr. Carlos Rodríguez - Score: 78.5
   Razones: ⚠️ Jurisdicción compatible: Buenos Aires
            ✅ Baja carga operativa (5/20 casos)
   Alertas: ⚠️ Penalización por rechazos recientes (-5 pts)
```

---

## 📊 Integración entre ambos servicios

### Flujo completo: WhatsApp → Lead → Asignación

```
┌─────────────────────────────────────────────────────┐
│  1. RECEPCIÓN DE CASO VÍA WHATSAPP                  │
│     - Usuario contacta por WhatsApp                 │
│     - Servicio de Onboarding procesa con IA         │
│     - Extrae datos estructurados                    │
│     - Valida viabilidad legal                       │
│     - Calcula monto estimado                        │
│     - Crea Lead en BD                               │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  2. EVENTO: NUEVO LEAD CREADO                       │
│     - Trigger automático en la BD                   │
│     - Webhook notifica al sistema de matching       │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  3. ALGORITMO DE MATCHING                           │
│     - Obtiene lista de abogados disponibles         │
│     - Calcula score para cada uno                   │
│     - Ordena por mejor match                        │
│     - Si score > 80 → Asignación automática         │
│     - Si score 60-80 → Sugerencia manual            │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  4. NOTIFICACIÓN AL ABOGADO ASIGNADO                │
│     - Email con resumen del caso                    │
│     - WhatsApp con alerta                           │
│     - Dashboard actualizado en tiempo real          │
│     - Timer de 24hs para aceptar/rechazar           │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  5. RESPUESTA DEL ABOGADO                           │
│     - Si acepta → Caso pasa a "in_progress"         │
│     - Si rechaza → Reasignación automática          │
│     - Actualización de scoring (penalización)       │
└─────────────────────────────────────────────────────┘
```

---

## 🔧 Setup e Instalación

### Dependencias

```json
{
  "dependencies": {
    "openai": "^4.20.0",
    "twilio": "^4.19.0",
    "@prisma/client": "^5.7.0",
    "axios": "^1.6.0",
    "form-data": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.3.0"
  }
}
```

### Variables de entorno

```bash
# OpenAI
OPENAI_API_KEY=sk-...

# Twilio WhatsApp
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_NUMBER=+14155238886

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/lexa

# Webhooks
WEBHOOK_SECRET=...
```

### Uso básico

```typescript
import { WhatsAppOnboardingService } from './lexa-onboarding-service';
import { CaseMatchingAlgorithm } from './lexa-matching-algorithm';

// 1. Inicializar servicio de onboarding
const onboarding = new WhatsAppOnboardingService(
  process.env.OPENAI_API_KEY!,
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
  process.env.TWILIO_WHATSAPP_NUMBER!
);

// 2. Webhook para mensajes entrantes
app.post('/webhook/whatsapp', async (req, res) => {
  await onboarding.processIncomingMessage({
    from: req.body.From.replace('whatsapp:', ''),
    to: req.body.To,
    body: req.body.Body,
    mediaUrl: req.body.MediaUrl0,
    mediaContentType: req.body.MediaContentType0,
    messageId: req.body.MessageSid,
  });
  
  res.sendStatus(200);
});

// 3. Evento al crear Lead → Trigger matching
prisma.$on('lead:created', async (lead) => {
  const matching = new CaseMatchingAlgorithm();
  const abogados = await prisma.user.findMany({
    where: { role: 'lawyer' }
  });
  
  const matches = await matching.findBestMatch(lead.case, abogados, {
    autoAssign: true, // Asignación automática si score > 80
    maxCandidates: 3,
  });
  
  console.log('Mejor match:', matches[0]);
});
```

---

## 📈 Métricas y KPIs del Sistema

### Onboarding Service
- **Tasa de conversión**: Mensajes → Leads calificados
- **Tiempo promedio de captación**: Desde primer mensaje hasta Lead creado
- **Tasa de abandono**: Usuarios que no completan el onboarding
- **Precisión de IA**: % de datos extraídos correctamente
- **Viabilidad legal**: % de casos viables vs no viables

### Matching Algorithm
- **Precisión de matching**: % de casos asignados correctamente al primer intento
- **Tasa de aceptación**: % de abogados que aceptan casos asignados
- **Tiempo de asignación**: Desde Lead creado hasta abogado asignado
- **Tasa de reasignación**: % de casos que requieren reasignación
- **Satisfacción del abogado**: Score promedio de matches

---

## 🔒 Seguridad y Compliance

### Datos sensibles
- Encriptación end-to-end en mensajes de WhatsApp
- Datos personales encriptados en BD (GDPR/Ley 25.326)
- Auditoría completa de accesos
- Anonimización para analytics

### Multi-tenancy
- Aislamiento por estudio jurídico (tenant_id)
- Row-Level Security en PostgreSQL
- Secrets segregados por tenant

---

## 🚀 Próximas mejoras

1. **Análisis predictivo de éxito**
   - Entrenar modelo ML para predecir probabilidad de ganar caso
   - Input: datos del caso + historial del abogado
   - Output: % de éxito esperado

2. **Optimización de matching con Reinforcement Learning**
   - Aprender de asignaciones pasadas
   - Ajustar pesos dinámicamente según performance real

3. **Integración con Poder Judicial**
   - Consulta automática de expedientes en SCBA
   - Notificaciones de actualizaciones judiciales

4. **Módulo de negociación asistida por IA**
   - Análisis de jurisprudencia similar
   - Sugerencias de montos de acuerdo
   - Generación de contraofertas

---

## 📞 Contacto

**Desarrollado para:** Sistema LEXA - Plataforma Legaltech Argentina

¿Necesitas personalizaciones o nuevas features? Los servicios están listos para producción.
