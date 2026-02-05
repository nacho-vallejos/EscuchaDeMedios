/**
 * LEXA - Algoritmo de Matching Inteligente
 * Sistema de asignación automática de casos a abogados
 * 
 * Criterios: Jurisdicción, Carga operativa, Scoring dinámico, Especialización
 */

import { PrismaClient } from '@prisma/client';

// ============================================
// TIPOS Y INTERFACES
// ============================================

interface Caso {
  id: string;
  tipo: 'despido' | 'accidente' | 'acoso' | 'aportes' | 'otro';
  jurisdiccion: {
    provincia: string;
    ciudad?: string;
    fuero?: 'nacional' | 'provincial';
  };
  montoEstimado: number;
  complejidad: 'baja' | 'media' | 'alta';
  urgencia: 'normal' | 'alta' | 'critica';
  requiereEspecializacion?: string[]; // Ej: ["accidentes_mortales", "multinacional"]
  createdAt: Date;
}

interface Abogado {
  id: string;
  nombre: string;
  email: string;
  tenantId: string;
  
  // Jurisdicción
  jurisdicciones: Array<{
    provincia: string;
    ciudades?: string[];
    fuero?: 'nacional' | 'provincial';
  }>;
  
  // Especialización
  especializaciones: string[]; // ["despido", "accidente"]
  certificaciones?: string[]; // ["especialista_art", "mediador_laboral"]
  
  // Carga operativa
  casosActivos: number;
  capacidadMaxima: number; // Máximo casos simultáneos
  
  // Performance histórico
  scoring: {
    totalCasosAsignados: number;
    totalCasosAceptados: number;
    totalCasosRechazados: number;
    tasaAceptacion: number; // 0-100
    tasaExito: number; // Casos ganados/totales
    promedioTiempoRespuesta: number; // horas
    ultimoRechazo?: Date;
  };
  
  // Disponibilidad
  disponible: boolean;
  vacaciones?: { desde: Date; hasta: Date };
  horarioAtencion?: { dias: number[]; horaInicio: number; horaFin: number };
  
  // Metadata
  experienciaAnios: number;
  calificacionClientes?: number; // 1-5 estrellas
  honorariosPorcentaje?: number; // % de la indemnización
}

interface MatchResult {
  abogado: Abogado;
  score: number;
  razones: string[];
  alertas?: string[];
}

// ============================================
// ALGORITMO DE MATCHING
// ============================================

export class CaseMatchingAlgorithm {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }

  /**
   * Encuentra el mejor abogado para un caso
   */
  async findBestMatch(
    caso: Caso,
    abogados: Abogado[],
    options?: {
      minScore?: number; // Score mínimo para considerar match (default: 50)
      maxCandidates?: number; // Top N candidatos a devolver (default: 1)
      autoAssign?: boolean; // Asignar automáticamente si score > 80
    }
  ): Promise<MatchResult[]> {
    const { minScore = 50, maxCandidates = 1, autoAssign = false } = options || {};

    // 1. Filtrar abogados disponibles
    const abogadosDisponibles = this.filterAvailableLawyers(abogados);

    if (abogadosDisponibles.length === 0) {
      throw new Error('No hay abogados disponibles en este momento');
    }

    // 2. Calcular score para cada abogado
    const matches: MatchResult[] = abogadosDisponibles.map((abogado) => {
      const result = this.calculateMatchScore(caso, abogado);
      return result;
    });

    // 3. Ordenar por score descendente
    matches.sort((a, b) => b.score - a.score);

    // 4. Filtrar por score mínimo
    const validMatches = matches.filter((m) => m.score >= minScore);

    if (validMatches.length === 0) {
      throw new Error(
        `No se encontraron abogados con score suficiente (mínimo: ${minScore})`
      );
    }

    // 5. Asignación automática si aplica
    const bestMatch = validMatches[0];
    if (autoAssign && bestMatch.score >= 80) {
      await this.assignCaseToLawyer(caso, bestMatch.abogado);
    }

    // 6. Retornar top N candidatos
    return validMatches.slice(0, maxCandidates);
  }

  /**
   * Calcula el score de matching entre un caso y un abogado
   */
  private calculateMatchScore(caso: Caso, abogado: Abogado): MatchResult {
    let score = 0;
    const razones: string[] = [];
    const alertas: string[] = [];

    // ============================================
    // 1. JURISDICCIÓN (Peso: 35%)
    // ============================================
    const jurisdiccionScore = this.calculateJurisdictionScore(caso, abogado);
    score += jurisdiccionScore * 0.35;
    
    if (jurisdiccionScore === 100) {
      razones.push(`✅ Jurisdicción exacta: ${caso.jurisdiccion.provincia}`);
    } else if (jurisdiccionScore >= 70) {
      razones.push(`⚠️ Jurisdicción compatible: ${caso.jurisdiccion.provincia}`);
    } else {
      alertas.push(`❌ Fuera de jurisdicción principal`);
    }

    // ============================================
    // 2. CARGA OPERATIVA (Peso: 25%)
    // ============================================
    const cargaScore = this.calculateWorkloadScore(abogado);
    score += cargaScore * 0.25;
    
    const porcentajeCarga = (abogado.casosActivos / abogado.capacidadMaxima) * 100;
    if (porcentajeCarga < 50) {
      razones.push(`✅ Baja carga operativa (${abogado.casosActivos}/${abogado.capacidadMaxima} casos)`);
    } else if (porcentajeCarga < 80) {
      razones.push(`⚠️ Carga moderada (${abogado.casosActivos}/${abogado.capacidadMaxima} casos)`);
    } else {
      alertas.push(`⚠️ Alta carga operativa (${abogado.casosActivos}/${abogado.capacidadMaxima} casos)`);
    }

    // ============================================
    // 3. ESPECIALIZACIÓN (Peso: 20%)
    // ============================================
    const especializacionScore = this.calculateSpecializationScore(caso, abogado);
    score += especializacionScore * 0.20;
    
    if (especializacionScore === 100) {
      razones.push(`✅ Especialista en ${caso.tipo}`);
    } else if (especializacionScore >= 50) {
      razones.push(`✔️ Experiencia en casos de ${caso.tipo}`);
    }

    // ============================================
    // 4. SCORING HISTÓRICO (Peso: 15%)
    // ============================================
    const performanceScore = this.calculatePerformanceScore(abogado);
    score += performanceScore * 0.15;
    
    if (abogado.scoring.tasaAceptacion >= 80) {
      razones.push(`✅ Alta tasa de aceptación (${abogado.scoring.tasaAceptacion}%)`);
    } else if (abogado.scoring.tasaAceptacion < 50) {
      alertas.push(`⚠️ Tasa de aceptación baja (${abogado.scoring.tasaAceptacion}%)`);
    }

    // ============================================
    // 5. PENALIZACIÓN POR RECHAZOS RECIENTES (Peso: -5%)
    // ============================================
    const penalizacionRechazo = this.calculateRejectionPenalty(abogado);
    score -= penalizacionRechazo;
    
    if (penalizacionRechazo > 0) {
      alertas.push(`⚠️ Penalización por rechazos recientes (-${penalizacionRechazo.toFixed(0)} pts)`);
    }

    // ============================================
    // 6. COMPLEJIDAD Y EXPERIENCIA (Peso: 5%)
    // ============================================
    const complejidadScore = this.matchComplexityWithExperience(caso, abogado);
    score += complejidadScore * 0.05;

    if (caso.complejidad === 'alta' && abogado.experienciaAnios < 5) {
      alertas.push(`⚠️ Caso complejo requiere más experiencia`);
    }

    // Score final (0-100)
    const finalScore = Math.max(0, Math.min(100, score));

    return {
      abogado,
      score: Math.round(finalScore * 100) / 100,
      razones,
      alertas: alertas.length > 0 ? alertas : undefined,
    };
  }

  /**
   * Calcula score de jurisdicción (0-100)
   */
  private calculateJurisdictionScore(caso: Caso, abogado: Abogado): number {
    const casoJuris = caso.jurisdiccion;
    
    for (const aboJuris of abogado.jurisdicciones) {
      // Match exacto: misma provincia
      if (aboJuris.provincia === casoJuris.provincia) {
        // Match perfecto: misma ciudad
        if (
          aboJuris.ciudades &&
          casoJuris.ciudad &&
          aboJuris.ciudades.includes(casoJuris.ciudad)
        ) {
          return 100;
        }
        
        // Match provincia sin ciudad específica
        return 90;
      }
      
      // Match fuero nacional (aplica en todas las provincias)
      if (aboJuris.fuero === 'nacional' && casoJuris.fuero === 'nacional') {
        return 80;
      }
    }
    
    // Sin match de jurisdicción
    return 0;
  }

  /**
   * Calcula score de carga operativa (0-100)
   * Menor carga = mayor score
   */
  private calculateWorkloadScore(abogado: Abogado): number {
    const porcentajeCarga = abogado.casosActivos / abogado.capacidadMaxima;
    
    if (porcentajeCarga >= 1) return 0; // Capacidad máxima alcanzada
    if (porcentajeCarga >= 0.9) return 20; // 90%+ de capacidad
    if (porcentajeCarga >= 0.75) return 50; // 75-90% de capacidad
    if (porcentajeCarga >= 0.5) return 75; // 50-75% de capacidad
    
    return 100; // Menos del 50% de capacidad
  }

  /**
   * Calcula score de especialización (0-100)
   */
  private calculateSpecializationScore(caso: Caso, abogado: Abogado): number {
    let score = 0;
    
    // Especialización principal
    if (abogado.especializaciones.includes(caso.tipo)) {
      score += 70;
    }
    
    // Certificaciones especiales
    if (caso.requiereEspecializacion) {
      const tieneTodasCertificaciones = caso.requiereEspecializacion.every((req) =>
        abogado.certificaciones?.includes(req)
      );
      
      if (tieneTodasCertificaciones) {
        score += 30;
      } else {
        score += 15; // Tiene algunas pero no todas
      }
    } else {
      score += 30; // No requiere especialización específica
    }
    
    return Math.min(100, score);
  }

  /**
   * Calcula score de performance histórico (0-100)
   */
  private calculatePerformanceScore(abogado: Abogado): number {
    const { tasaAceptacion, tasaExito, promedioTiempoRespuesta } = abogado.scoring;
    
    // Componente 1: Tasa de aceptación (40%)
    const aceptacionScore = tasaAceptacion * 0.4;
    
    // Componente 2: Tasa de éxito (40%)
    const exitoScore = tasaExito * 0.4;
    
    // Componente 3: Tiempo de respuesta (20%)
    // Ideal: < 4 horas = 100pts, > 24 horas = 0pts
    let tiempoScore = 0;
    if (promedioTiempoRespuesta <= 4) {
      tiempoScore = 100;
    } else if (promedioTiempoRespuesta <= 24) {
      tiempoScore = 100 - ((promedioTiempoRespuesta - 4) / 20) * 100;
    }
    tiempoScore *= 0.2;
    
    return aceptacionScore + exitoScore + tiempoScore;
  }

  /**
   * Calcula penalización por rechazos recientes
   */
  private calculateRejectionPenalty(abogado: Abogado): number {
    const { ultimoRechazo, totalCasosRechazados, totalCasosAsignados } = abogado.scoring;
    
    if (!ultimoRechazo || totalCasosAsignados === 0) return 0;
    
    const diasDesdeUltimoRechazo = Math.floor(
      (Date.now() - ultimoRechazo.getTime()) / (1000 * 60 * 60 * 24)
    );
    
    // Penalización solo si el rechazo fue en los últimos 7 días
    if (diasDesdeUltimoRechazo > 7) return 0;
    
    // Penalización base: 5 puntos
    let penalizacion = 5;
    
    // Penalización adicional si tiene múltiples rechazos recientes
    const tasaRechazo = (totalCasosRechazados / totalCasosAsignados) * 100;
    if (tasaRechazo > 30) {
      penalizacion += 10; // Penalización extra por alta tasa de rechazo
    }
    
    // La penalización disminuye con el tiempo
    const factorTiempo = (7 - diasDesdeUltimoRechazo) / 7;
    return penalizacion * factorTiempo;
  }

  /**
   * Match entre complejidad del caso y experiencia del abogado
   */
  private matchComplexityWithExperience(caso: Caso, abogado: Abogado): number {
    const experiencia = abogado.experienciaAnios;
    
    switch (caso.complejidad) {
      case 'baja':
        return experiencia >= 1 ? 100 : 50;
      
      case 'media':
        if (experiencia >= 5) return 100;
        if (experiencia >= 3) return 80;
        return 50;
      
      case 'alta':
        if (experiencia >= 10) return 100;
        if (experiencia >= 7) return 80;
        if (experiencia >= 5) return 60;
        return 30; // Penalización fuerte si es muy junior
      
      default:
        return 70;
    }
  }

  /**
   * Filtra abogados disponibles
   */
  private filterAvailableLawyers(abogados: Abogado[]): Abogado[] {
    const ahora = new Date();
    
    return abogados.filter((abo) => {
      // No disponible
      if (!abo.disponible) return false;
      
      // En vacaciones
      if (abo.vacaciones) {
        const { desde, hasta } = abo.vacaciones;
        if (ahora >= desde && ahora <= hasta) return false;
      }
      
      // Capacidad máxima alcanzada
      if (abo.casosActivos >= abo.capacidadMaxima) return false;
      
      // Fuera de horario de atención (si está configurado)
      if (abo.horarioAtencion) {
        const diaActual = ahora.getDay();
        const horaActual = ahora.getHours();
        
        if (
          !abo.horarioAtencion.dias.includes(diaActual) ||
          horaActual < abo.horarioAtencion.horaInicio ||
          horaActual > abo.horarioAtencion.horaFin
        ) {
          return false;
        }
      }
      
      return true;
    });
  }

  /**
   * Asigna caso a abogado y actualiza métricas
   */
  private async assignCaseToLawyer(caso: Caso, abogado: Abogado): Promise<void> {
    await this.prisma.$transaction([
      // Actualizar caso
      this.prisma.case.update({
        where: { id: caso.id },
        data: {
          assignedToId: abogado.id,
          status: 'assigned',
          assignedAt: new Date(),
        },
      }),
      
      // Incrementar casos activos del abogado
      this.prisma.user.update({
        where: { id: abogado.id },
        data: {
          casosActivos: { increment: 1 },
        },
      }),
      
      // Registrar evento de asignación
      this.prisma.caseEvent.create({
        data: {
          caseId: caso.id,
          type: 'assignment',
          userId: abogado.id,
          metadata: {
            autoAssigned: true,
            assignmentTimestamp: new Date(),
          },
        },
      }),
    ]);
    
    // Enviar notificación al abogado
    await this.notifyLawyerAboutAssignment(caso, abogado);
  }

  /**
   * Registra rechazo de caso y actualiza scoring
   */
  async recordCaseRejection(casoId: string, abogadoId: string, razon?: string): Promise<void> {
    await this.prisma.$transaction([
      // Actualizar scoring del abogado
      this.prisma.user.update({
        where: { id: abogadoId },
        data: {
          'scoring.totalCasosRechazados': { increment: 1 },
          'scoring.ultimoRechazo': new Date(),
        },
      }),
      
      // Recalcular tasa de aceptación
      this.prisma.$executeRaw`
        UPDATE "User" 
        SET "scoring" = jsonb_set(
          "scoring", 
          '{tasaAceptacion}',
          to_jsonb(
            (("scoring"->>'totalCasosAceptados')::int * 100.0) / 
            NULLIF(("scoring"->>'totalCasosAsignados')::int, 0)
          )
        )
        WHERE id = ${abogadoId}
      `,
      
      // Registrar evento de rechazo
      this.prisma.caseEvent.create({
        data: {
          caseId: casoId,
          type: 'rejection',
          userId: abogadoId,
          metadata: {
            razon,
            timestamp: new Date(),
          },
        },
      }),
    ]);
    
    // Intentar reasignar el caso a otro abogado
    await this.reassignRejectedCase(casoId, abogadoId);
  }

  /**
   * Reasigna caso rechazado a otro abogado
   */
  private async reassignRejectedCase(casoId: string, abogadoRechazadoId: string): Promise<void> {
    const caso = await this.prisma.case.findUnique({
      where: { id: casoId },
    }) as unknown as Caso;
    
    // Obtener otros abogados disponibles
    const abogados = await this.prisma.user.findMany({
      where: {
        id: { not: abogadoRechazadoId },
        role: 'lawyer',
        disponible: true,
      },
    }) as unknown as Abogado[];
    
    // Buscar nuevo match
    const matches = await this.findBestMatch(caso, abogados, {
      maxCandidates: 3,
      minScore: 60,
    });
    
    if (matches.length > 0) {
      await this.assignCaseToLawyer(caso, matches[0].abogado);
    }
  }

  /**
   * Notifica al abogado sobre nueva asignación
   */
  private async notifyLawyerAboutAssignment(caso: Caso, abogado: Abogado): Promise<void> {
    // Implementar notificación (email, push, WhatsApp)
    console.log(`📧 Notificando a ${abogado.nombre} sobre caso ${caso.id}`);
  }
}

// ============================================
// EJEMPLO DE USO
// ============================================

/*
const matchingAlgorithm = new CaseMatchingAlgorithm();

const caso: Caso = {
  id: 'case-123',
  tipo: 'despido',
  jurisdiccion: {
    provincia: 'Buenos Aires',
    ciudad: 'La Plata',
    fuero: 'provincial',
  },
  montoEstimado: 5000000, // ARS
  complejidad: 'media',
  urgencia: 'alta',
  createdAt: new Date(),
};

const abogados: Abogado[] = [
  {
    id: 'abg-001',
    nombre: 'Dr. Juan Pérez',
    email: 'jperez@lexa.com.ar',
    tenantId: 'tenant-1',
    jurisdicciones: [
      { provincia: 'Buenos Aires', ciudades: ['La Plata', 'CABA'] },
    ],
    especializaciones: ['despido', 'acoso'],
    casosActivos: 8,
    capacidadMaxima: 15,
    scoring: {
      totalCasosAsignados: 120,
      totalCasosAceptados: 110,
      totalCasosRechazados: 10,
      tasaAceptacion: 91.7,
      tasaExito: 85,
      promedioTiempoRespuesta: 3.5,
    },
    disponible: true,
    experienciaAnios: 12,
    calificacionClientes: 4.8,
  },
  // ... más abogados
];

const matches = await matchingAlgorithm.findBestMatch(caso, abogados, {
  maxCandidates: 3,
  autoAssign: true,
});

console.log('Top 3 matches:');
matches.forEach((match, i) => {
  console.log(`${i + 1}. ${match.abogado.nombre} - Score: ${match.score}`);
  console.log('   Razones:', match.razones.join(', '));
  if (match.alertas) {
    console.log('   Alertas:', match.alertas.join(', '));
  }
});
*/
