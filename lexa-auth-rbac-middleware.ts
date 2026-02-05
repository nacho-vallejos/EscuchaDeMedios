/**
 * LEXA - Sistema de Autenticación, RBAC y Auditoría
 * Middleware de seguridad para CRM Jurídico con multi-tenancy
 * 
 * Cumplimiento: Confidencialidad, Segregación de Datos, Auditoría Completa
 * Stack: NestJS + Prisma + JWT + bcrypt
 * 
 * @author Sistema LEXA
 * @date 2026-02-05
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  Logger,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '@/lib/prisma';
import * as bcrypt from 'bcrypt';
import { Request } from 'express';

// ============================================
// TIPOS Y ENUMS
// ============================================

/**
 * Roles del sistema
 */
export enum Role {
  ADMIN = 'ADMIN',           // Acceso total al sistema
  ABOGADO = 'ABOGADO',       // Abogado - solo su estudio
  BACKOFFICE = 'BACKOFFICE', // Personal administrativo
  TRABAJADOR = 'TRABAJADOR', // Trabajador con caso
}

/**
 * Permisos granulares del sistema
 */
export enum Permission {
  // Gestión de Casos
  CASO_READ = 'caso:read',
  CASO_CREATE = 'caso:create',
  CASO_UPDATE = 'caso:update',
  CASO_DELETE = 'caso:delete',
  CASO_ASSIGN = 'caso:assign',
  
  // Gestión de Abogados
  ABOGADO_READ = 'abogado:read',
  ABOGADO_CREATE = 'abogado:create',
  ABOGADO_UPDATE = 'abogado:update',
  ABOGADO_DELETE = 'abogado:delete',
  
  // Gestión de Trabajadores
  TRABAJADOR_READ = 'trabajador:read',
  TRABAJADOR_UPDATE = 'trabajador:update',
  
  // Documentos
  DOCUMENTO_READ = 'documento:read',
  DOCUMENTO_UPLOAD = 'documento:upload',
  DOCUMENTO_DELETE = 'documento:delete',
  
  // Pagos
  PAGO_READ = 'pago:read',
  PAGO_CREATE = 'pago:create',
  
  // Auditoría
  AUDITORIA_READ = 'auditoria:read',
  
  // Configuración
  CONFIG_MANAGE = 'config:manage',
}

/**
 * Tipo de acción auditada
 */
export enum AccionAuditoria {
  LOGIN = 'LOGIN',
  LOGOUT = 'LOGOUT',
  CASO_VIEW = 'CASO_VIEW',
  CASO_CREATE = 'CASO_CREATE',
  CASO_UPDATE = 'CASO_UPDATE',
  CASO_ASSIGN = 'CASO_ASSIGN',
  DOCUMENTO_VIEW = 'DOCUMENTO_VIEW',
  DOCUMENTO_UPLOAD = 'DOCUMENTO_UPLOAD',
  DOCUMENTO_DELETE = 'DOCUMENTO_DELETE',
  PAGO_CREATE = 'PAGO_CREATE',
  ABOGADO_CREATE = 'ABOGADO_CREATE',
  TRABAJADOR_UPDATE = 'TRABAJADOR_UPDATE',
  UNAUTHORIZED_ACCESS = 'UNAUTHORIZED_ACCESS',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
}

/**
 * Payload del JWT
 */
export interface JwtPayload {
  userId: string;
  email: string;
  role: Role;
  estudioId?: string; // Para abogados
  trabajadorId?: string; // Para trabajadores
  tenantId: string; // Multi-tenancy
  permissions: Permission[];
  iat?: number;
  exp?: number;
}

/**
 * Usuario autenticado (extendido en Request)
 */
export interface AuthenticatedUser extends JwtPayload {
  sessionId: string;
}

/**
 * Contexto de auditoría
 */
interface AuditoriaContext {
  userId: string;
  accion: AccionAuditoria;
  recursoTipo: string;
  recursoId?: string;
  detalles?: any;
  ipAddress?: string;
  userAgent?: string;
  tenantId: string;
}

// ============================================
// MATRIZ DE PERMISOS POR ROL
// ============================================

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [Role.ADMIN]: [
    // Acceso total
    Permission.CASO_READ,
    Permission.CASO_CREATE,
    Permission.CASO_UPDATE,
    Permission.CASO_DELETE,
    Permission.CASO_ASSIGN,
    Permission.ABOGADO_READ,
    Permission.ABOGADO_CREATE,
    Permission.ABOGADO_UPDATE,
    Permission.ABOGADO_DELETE,
    Permission.TRABAJADOR_READ,
    Permission.TRABAJADOR_UPDATE,
    Permission.DOCUMENTO_READ,
    Permission.DOCUMENTO_UPLOAD,
    Permission.DOCUMENTO_DELETE,
    Permission.PAGO_READ,
    Permission.PAGO_CREATE,
    Permission.AUDITORIA_READ,
    Permission.CONFIG_MANAGE,
  ],
  
  [Role.ABOGADO]: [
    // Solo casos asignados a su estudio
    Permission.CASO_READ,
    Permission.CASO_UPDATE,
    Permission.TRABAJADOR_READ,
    Permission.DOCUMENTO_READ,
    Permission.DOCUMENTO_UPLOAD,
    Permission.PAGO_READ,
  ],
  
  [Role.BACKOFFICE]: [
    // Gestión operativa sin acceso a documentos sensibles
    Permission.CASO_READ,
    Permission.CASO_CREATE,
    Permission.CASO_ASSIGN,
    Permission.TRABAJADOR_READ,
    Permission.TRABAJADOR_UPDATE,
    Permission.ABOGADO_READ,
    Permission.PAGO_READ,
  ],
  
  [Role.TRABAJADOR]: [
    // Solo su propio caso
    Permission.CASO_READ,
    Permission.DOCUMENTO_READ,
    Permission.DOCUMENTO_UPLOAD,
    Permission.PAGO_READ,
  ],
};

// ============================================
// DECORADORES PERSONALIZADOS
// ============================================

/**
 * Decorador para marcar roles requeridos
 */
export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);

/**
 * Decorador para marcar permisos requeridos
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata('permissions', permissions);

/**
 * Decorador para marcar endpoints públicos (sin auth)
 */
export const Public = () => SetMetadata('isPublic', true);

/**
 * Decorador para obtener el usuario autenticado
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const user = request['user'] as AuthenticatedUser;

    return data ? user?.[data] : user;
  },
);

/**
 * Decorador para auditar acciones automáticamente
 */
export const Auditable = (accion: AccionAuditoria, recursoTipo: string) =>
  SetMetadata('auditoria', { accion, recursoTipo });

// ============================================
// SERVICIO DE AUTENTICACIÓN
// ============================================

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Registrar nuevo usuario
   */
  async register(data: {
    email: string;
    password: string;
    nombre: string;
    apellido: string;
    role: Role;
    tenantId: string;
    estudioId?: string;
  }) {
    this.logger.log(`Registrando usuario: ${data.email} (${data.role})`);

    // Verificar si el email ya existe
    const existente = await this.prisma.usuario.findUnique({
      where: { email: data.email },
    });

    if (existente) {
      this.logger.warn(`Email duplicado: ${data.email}`);
      throw new ForbiddenException('El email ya está registrado');
    }

    // Hash de contraseña
    const passwordHash = await bcrypt.hash(data.password, 12);

    // Crear usuario
    const usuario = await this.prisma.usuario.create({
      data: {
        email: data.email,
        passwordHash,
        nombre: data.nombre,
        apellido: data.apellido,
        role: data.role,
        tenantId: data.tenantId,
        estudioId: data.estudioId,
        activo: true,
      },
    });

    this.logger.log(`✓ Usuario creado: ${usuario.id} - ${usuario.email}`);

    return {
      id: usuario.id,
      email: usuario.email,
      nombre: usuario.nombre,
      apellido: usuario.apellido,
      role: usuario.role,
    };
  }

  /**
   * Login de usuario
   */
  async login(email: string, password: string, ipAddress?: string, userAgent?: string) {
    this.logger.log(`Intento de login: ${email}`);

    // Buscar usuario
    const usuario = await this.prisma.usuario.findUnique({
      where: { email },
      include: {
        estudio: true,
      },
    });

    if (!usuario) {
      this.logger.warn(`Usuario no encontrado: ${email}`);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    if (!usuario.activo) {
      this.logger.warn(`Usuario inactivo: ${email}`);
      throw new ForbiddenException('Usuario desactivado');
    }

    // Verificar contraseña
    const passwordValida = await bcrypt.compare(password, usuario.passwordHash);

    if (!passwordValida) {
      this.logger.warn(`Contraseña incorrecta: ${email}`);
      
      // Auditar intento fallido
      await this.auditarAccion({
        userId: usuario.id,
        accion: AccionAuditoria.UNAUTHORIZED_ACCESS,
        recursoTipo: 'LOGIN',
        detalles: { email, exito: false },
        ipAddress,
        userAgent,
        tenantId: usuario.tenantId,
      });

      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Generar tokens
    const tokens = await this.generateTokens(usuario);

    // Auditar login exitoso
    await this.auditarAccion({
      userId: usuario.id,
      accion: AccionAuditoria.LOGIN,
      recursoTipo: 'AUTH',
      detalles: { email, exito: true },
      ipAddress,
      userAgent,
      tenantId: usuario.tenantId,
    });

    // Actualizar último login
    await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: { ultimoLogin: new Date() },
    });

    this.logger.log(`✓ Login exitoso: ${usuario.email} (${usuario.role})`);

    return {
      user: {
        id: usuario.id,
        email: usuario.email,
        nombre: usuario.nombre,
        apellido: usuario.apellido,
        role: usuario.role,
        estudio: usuario.estudio,
      },
      ...tokens,
    };
  }

  /**
   * Generar tokens JWT
   */
  private async generateTokens(usuario: any) {
    const permissions = ROLE_PERMISSIONS[usuario.role as Role] || [];

    const payload: JwtPayload = {
      userId: usuario.id,
      email: usuario.email,
      role: usuario.role,
      tenantId: usuario.tenantId,
      estudioId: usuario.estudioId,
      permissions,
    };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: '1h',
    });

    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: '7d',
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 3600,
    };
  }

  /**
   * Validar token JWT
   */
  async validateToken(token: string): Promise<JwtPayload> {
    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      
      // Verificar que el usuario siga activo
      const usuario = await this.prisma.usuario.findUnique({
        where: { id: payload.userId },
        select: { activo: true },
      });

      if (!usuario || !usuario.activo) {
        throw new UnauthorizedException('Usuario inactivo o eliminado');
      }

      return payload;
    } catch (error) {
      this.logger.warn(`Token inválido: ${error.message}`);
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }

  /**
   * Refrescar token
   */
  async refreshToken(refreshToken: string) {
    const payload = await this.validateToken(refreshToken);

    const usuario = await this.prisma.usuario.findUnique({
      where: { id: payload.userId },
    });

    if (!usuario) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    return this.generateTokens(usuario);
  }

  /**
   * Auditar acción
   */
  private async auditarAccion(context: AuditoriaContext) {
    try {
      await this.prisma.auditoria.create({
        data: {
          userId: context.userId,
          accion: context.accion,
          recursoTipo: context.recursoTipo,
          recursoId: context.recursoId,
          detalles: context.detalles,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          tenantId: context.tenantId,
          timestamp: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(`Error auditando acción: ${error.message}`);
    }
  }
}

// ============================================
// GUARDS DE AUTENTICACIÓN Y AUTORIZACIÓN
// ============================================

/**
 * Guard JWT - Verifica autenticación
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Verificar si es endpoint público
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      this.logger.warn('Token no provisto');
      throw new UnauthorizedException('Token de autenticación requerido');
    }

    try {
      const payload = await this.authService.validateToken(token);
      request['user'] = payload;
      
      this.logger.debug(`Usuario autenticado: ${payload.email} (${payload.role})`);
      
      return true;
    } catch (error) {
      this.logger.warn(`Autenticación fallida: ${error.message}`);
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}

/**
 * Guard de Roles - Verifica rol del usuario
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request['user'] as AuthenticatedUser;

    if (!user) {
      this.logger.warn('Usuario no autenticado en RolesGuard');
      throw new UnauthorizedException('Usuario no autenticado');
    }

    const hasRole = requiredRoles.includes(user.role);

    if (!hasRole) {
      this.logger.warn(
        `Acceso denegado: ${user.email} (${user.role}) requiere uno de [${requiredRoles.join(', ')}]`,
      );
      throw new ForbiddenException('No tienes permisos para acceder a este recurso');
    }

    this.logger.debug(`✓ Rol verificado: ${user.email} tiene rol ${user.role}`);
    return true;
  }
}

/**
 * Guard de Permisos - Verifica permisos granulares
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      'permissions',
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request['user'] as AuthenticatedUser;

    if (!user) {
      throw new UnauthorizedException('Usuario no autenticado');
    }

    const hasPermissions = requiredPermissions.every((permission) =>
      user.permissions.includes(permission),
    );

    if (!hasPermissions) {
      this.logger.warn(
        `Permiso denegado: ${user.email} requiere [${requiredPermissions.join(', ')}]`,
      );
      throw new ForbiddenException('No tienes los permisos necesarios');
    }

    this.logger.debug(`✓ Permisos verificados: ${user.email}`);
    return true;
  }
}

/**
 * Guard de Tenancy - Asegura acceso solo a recursos del tenant
 */
@Injectable()
export class TenancyGuard implements CanActivate {
  private readonly logger = new Logger(TenancyGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request['user'] as AuthenticatedUser;

    if (!user) {
      throw new UnauthorizedException('Usuario no autenticado');
    }

    // Admin tiene acceso a todos los tenants
    if (user.role === Role.ADMIN) {
      return true;
    }

    // Para otros roles, verificar tenantId en params/body
    const casoId = request.params.casoId || request.body?.casoId;

    if (casoId) {
      const caso = await this.prisma.caso.findUnique({
        where: { id: casoId },
        select: { tenantId: true, estudioId: true },
      });

      if (!caso) {
        this.logger.warn(`Caso no encontrado: ${casoId}`);
        throw new ForbiddenException('Recurso no encontrado');
      }

      // Verificar tenant
      if (caso.tenantId !== user.tenantId) {
        this.logger.warn(
          `Acceso cross-tenant bloqueado: ${user.email} intentó acceder a tenant ${caso.tenantId}`,
        );
        throw new ForbiddenException('No tienes acceso a este recurso');
      }

      // Si es abogado, verificar que el caso esté asignado a su estudio
      if (user.role === Role.ABOGADO) {
        if (caso.estudioId !== user.estudioId) {
          this.logger.warn(
            `Abogado ${user.email} intentó acceder a caso de otro estudio`,
          );
          throw new ForbiddenException(
            'Este caso no está asignado a tu estudio jurídico',
          );
        }
      }
    }

    return true;
  }
}

// ============================================
// SERVICIO DE AUDITORÍA
// ============================================

@Injectable()
export class AuditoriaService {
  private readonly logger = new Logger(AuditoriaService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registrar acceso a documento
   */
  async auditarAccesoDocumento(
    userId: string,
    documentoId: string,
    accion: AccionAuditoria,
    request?: Request,
  ) {
    const documento = await this.prisma.documento.findUnique({
      where: { id: documentoId },
      include: { caso: true },
    });

    if (!documento) {
      this.logger.warn(`Documento no encontrado: ${documentoId}`);
      return;
    }

    await this.registrarAuditoria({
      userId,
      accion,
      recursoTipo: 'DOCUMENTO',
      recursoId: documentoId,
      detalles: {
        documentoNombre: documento.nombre,
        casoId: documento.casoId,
        tipoDocumento: documento.tipo,
      },
      ipAddress: request?.ip,
      userAgent: request?.headers['user-agent'],
      tenantId: documento.caso.tenantId,
    });

    this.logger.log(
      `📄 Auditoría: Usuario ${userId} ${accion} documento ${documento.nombre}`,
    );
  }

  /**
   * Registrar acceso a caso
   */
  async auditarAccesoCaso(
    userId: string,
    casoId: string,
    accion: AccionAuditoria,
    request?: Request,
  ) {
    const caso = await this.prisma.caso.findUnique({
      where: { id: casoId },
    });

    if (!caso) {
      this.logger.warn(`Caso no encontrado: ${casoId}`);
      return;
    }

    await this.registrarAuditoria({
      userId,
      accion,
      recursoTipo: 'CASO',
      recursoId: casoId,
      detalles: {
        casoTitulo: caso.titulo,
        estado: caso.estado,
        jurisdiccion: caso.jurisdiccion,
      },
      ipAddress: request?.ip,
      userAgent: request?.headers['user-agent'],
      tenantId: caso.tenantId,
    });

    this.logger.log(`⚖️  Auditoría: Usuario ${userId} ${accion} caso ${casoId}`);
  }

  /**
   * Registrar auditoría genérica
   */
  async registrarAuditoria(context: AuditoriaContext) {
    try {
      await this.prisma.auditoria.create({
        data: {
          userId: context.userId,
          accion: context.accion,
          recursoTipo: context.recursoTipo,
          recursoId: context.recursoId,
          detalles: context.detalles || {},
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          tenantId: context.tenantId,
          timestamp: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(`Error registrando auditoría: ${error.message}`, error.stack);
    }
  }

  /**
   * Obtener historial de auditoría de un caso
   */
  async obtenerHistorialCaso(casoId: string, userId: string) {
    this.logger.log(`Consultando historial de auditoría: caso ${casoId}`);

    const registros = await this.prisma.auditoria.findMany({
      where: {
        recursoTipo: 'CASO',
        recursoId: casoId,
      },
      include: {
        usuario: {
          select: {
            nombre: true,
            apellido: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: { timestamp: 'desc' },
      take: 100,
    });

    // Auditar que se consultó el historial
    await this.registrarAuditoria({
      userId,
      accion: AccionAuditoria.CASO_VIEW,
      recursoTipo: 'AUDITORIA',
      recursoId: casoId,
      detalles: { tipo: 'historial_consulta' },
      tenantId: registros[0]?.tenantId || '',
    });

    return registros;
  }

  /**
   * Obtener quién accedió a un documento
   */
  async obtenerAccesosDocumento(documentoId: string) {
    const accesos = await this.prisma.auditoria.findMany({
      where: {
        recursoTipo: 'DOCUMENTO',
        recursoId: documentoId,
        accion: {
          in: [
            AccionAuditoria.DOCUMENTO_VIEW,
            AccionAuditoria.DOCUMENTO_UPLOAD,
            AccionAuditoria.DOCUMENTO_DELETE,
          ],
        },
      },
      include: {
        usuario: {
          select: {
            nombre: true,
            apellido: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: { timestamp: 'desc' },
    });

    return accesos.map((acceso) => ({
      accion: acceso.accion,
      usuario: `${acceso.usuario.nombre} ${acceso.usuario.apellido}`,
      email: acceso.usuario.email,
      role: acceso.usuario.role,
      fecha: acceso.timestamp,
      ipAddress: acceso.ipAddress,
    }));
  }

  /**
   * Detectar accesos sospechosos
   */
  async detectarAccesosSospechosos(tenantId: string, ventanaHoras: number = 24) {
    const desde = new Date();
    desde.setHours(desde.getHours() - ventanaHoras);

    // Buscar múltiples intentos fallidos
    const intentosFallidos = await this.prisma.auditoria.groupBy({
      by: ['userId', 'ipAddress'],
      where: {
        tenantId,
        accion: {
          in: [AccionAuditoria.UNAUTHORIZED_ACCESS, AccionAuditoria.PERMISSION_DENIED],
        },
        timestamp: { gte: desde },
      },
      _count: { id: true },
      having: {
        id: { _count: { gt: 5 } },
      },
    });

    if (intentosFallidos.length > 0) {
      this.logger.warn(
        `⚠️  Detectados ${intentosFallidos.length} patrones de acceso sospechoso`,
      );
    }

    return intentosFallidos;
  }
}

// ============================================
// INTERCEPTOR DE AUDITORÍA AUTOMÁTICA
// ============================================

@Injectable()
export class AuditoriaInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditoriaInterceptor.name);

  constructor(
    private readonly auditoriaService: AuditoriaService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const auditoriaMetadata = this.reflector.get<{
      accion: AccionAuditoria;
      recursoTipo: string;
    }>('auditoria', context.getHandler());

    if (!auditoriaMetadata) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request['user'] as AuthenticatedUser;

    if (!user) {
      return next.handle();
    }

    const { accion, recursoTipo } = auditoriaMetadata;
    const recursoId = request.params.id || request.body?.id;

    // Ejecutar request
    const now = Date.now();
    return next.handle().pipe(
      tap(async () => {
        const duracion = Date.now() - now;

        await this.auditoriaService.registrarAuditoria({
          userId: user.userId,
          accion,
          recursoTipo,
          recursoId,
          detalles: {
            method: request.method,
            path: request.path,
            duracion,
            exito: true,
          },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          tenantId: user.tenantId,
        });

        this.logger.debug(
          `✓ Auditoría automática: ${user.email} ${accion} ${recursoTipo} (${duracion}ms)`,
        );
      }),
    );
  }
}

// ============================================
// PRISMA MIDDLEWARE PARA ROW-LEVEL SECURITY
// ============================================

/**
 * Middleware de Prisma para aplicar Row-Level Security (RLS)
 * Automáticamente filtra queries por tenantId
 */
export function createTenancyMiddleware() {
  return async (params: any, next: any) => {
    // Obtener contexto del usuario (debe ser inyectado via AsyncLocalStorage)
    const tenantId = getTenantIdFromContext();

    if (!tenantId) {
      return next(params);
    }

    // Modelos con multi-tenancy
    const modelsWithTenancy = [
      'Caso',
      'Trabajador',
      'Documento',
      'Pago',
      'Auditoria',
      'Estudio',
    ];

    if (modelsWithTenancy.includes(params.model)) {
      // Aplicar filtro de tenantId en queries
      if (params.action === 'findUnique' || params.action === 'findFirst') {
        params.args.where = {
          ...params.args.where,
          tenantId,
        };
      }

      if (
        params.action === 'findMany' ||
        params.action === 'count' ||
        params.action === 'aggregate'
      ) {
        if (!params.args) params.args = {};
        if (!params.args.where) params.args.where = {};
        params.args.where.tenantId = tenantId;
      }

      // En creates, inyectar tenantId automáticamente
      if (params.action === 'create') {
        params.args.data = {
          ...params.args.data,
          tenantId,
        };
      }

      if (params.action === 'createMany') {
        if (Array.isArray(params.args.data)) {
          params.args.data = params.args.data.map((item: any) => ({
            ...item,
            tenantId,
          }));
        }
      }

      // Aplicar filtro en updates/deletes
      if (
        params.action === 'update' ||
        params.action === 'updateMany' ||
        params.action === 'delete' ||
        params.action === 'deleteMany'
      ) {
        if (!params.args.where) params.args.where = {};
        params.args.where.tenantId = tenantId;
      }
    }

    return next(params);
  };
}

/**
 * Función auxiliar para obtener tenantId del contexto
 * En producción, usar AsyncLocalStorage o cls-hooked
 */
function getTenantIdFromContext(): string | undefined {
  // Implementación simplificada
  // En producción: usar AsyncLocalStorage para propagar el contexto
  return undefined;
}

// ============================================
// EJEMPLO DE USO EN CONTROLLER
// ============================================

/**
 * Ejemplo: Controller de Casos con RBAC y Auditoría
 */
/*
@Controller('casos')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenancyGuard)
@UseInterceptors(AuditoriaInterceptor)
export class CasosController {
  constructor(
    private readonly casosService: CasosService,
    private readonly auditoriaService: AuditoriaService,
  ) {}

  // Endpoint: Listar casos (solo los del abogado)
  @Get()
  @Roles(Role.ABOGADO, Role.ADMIN, Role.BACKOFFICE)
  @RequirePermissions(Permission.CASO_READ)
  @Auditable(AccionAuditoria.CASO_VIEW, 'CASO')
  async listarCasos(@CurrentUser() user: AuthenticatedUser) {
    // El middleware RLS filtrará automáticamente por tenantId y estudioId
    return this.casosService.listarCasos(user);
  }

  // Endpoint: Ver detalle de caso
  @Get(':casoId')
  @Roles(Role.ABOGADO, Role.ADMIN)
  @RequirePermissions(Permission.CASO_READ)
  async obtenerCaso(
    @Param('casoId') casoId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    // Auditar acceso
    await this.auditoriaService.auditarAccesoCaso(
      user.userId,
      casoId,
      AccionAuditoria.CASO_VIEW,
      request,
    );

    return this.casosService.obtenerCaso(casoId, user);
  }

  // Endpoint: Crear caso (solo backoffice/admin)
  @Post()
  @Roles(Role.BACKOFFICE, Role.ADMIN)
  @RequirePermissions(Permission.CASO_CREATE)
  @Auditable(AccionAuditoria.CASO_CREATE, 'CASO')
  async crearCaso(
    @Body() data: CreateCasoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.casosService.crearCaso(data, user);
  }

  // Endpoint: Asignar caso a abogado
  @Post(':casoId/asignar')
  @Roles(Role.BACKOFFICE, Role.ADMIN)
  @RequirePermissions(Permission.CASO_ASSIGN)
  @Auditable(AccionAuditoria.CASO_ASSIGN, 'CASO')
  async asignarCaso(
    @Param('casoId') casoId: string,
    @Body() data: { estudioId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.casosService.asignarCaso(casoId, data.estudioId, user);
  }

  // Endpoint: Ver historial de auditoría
  @Get(':casoId/auditoria')
  @Roles(Role.ADMIN, Role.ABOGADO)
  @RequirePermissions(Permission.AUDITORIA_READ)
  async obtenerHistorial(
    @Param('casoId') casoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.auditoriaService.obtenerHistorialCaso(casoId, user.userId);
  }

  // Endpoint: Ver quién accedió a un documento
  @Get('documentos/:documentoId/accesos')
  @Roles(Role.ADMIN, Role.ABOGADO)
  @RequirePermissions(Permission.AUDITORIA_READ)
  async obtenerAccesosDocumento(@Param('documentoId') documentoId: string) {
    return this.auditoriaService.obtenerAccesosDocumento(documentoId);
  }
}
*/

// ============================================
// SCHEMA PRISMA REQUERIDO
// ============================================

/**
 * Agregar al schema.prisma:
 * 
 * model Usuario {
 *   id            String    @id @default(cuid())
 *   email         String    @unique
 *   passwordHash  String
 *   nombre        String
 *   apellido      String
 *   role          String    // ADMIN | ABOGADO | BACKOFFICE | TRABAJADOR
 *   tenantId      String
 *   estudioId     String?
 *   activo        Boolean   @default(true)
 *   ultimoLogin   DateTime?
 *   createdAt     DateTime  @default(now())
 *   
 *   estudio       Estudio?  @relation(fields: [estudioId], references: [id])
 *   auditorias    Auditoria[]
 * }
 * 
 * model Auditoria {
 *   id           String   @id @default(cuid())
 *   userId       String
 *   accion       String   // LOGIN, CASO_VIEW, DOCUMENTO_VIEW, etc.
 *   recursoTipo  String   // CASO, DOCUMENTO, PAGO, etc.
 *   recursoId    String?
 *   detalles     Json?
 *   ipAddress    String?
 *   userAgent    String?
 *   tenantId     String
 *   timestamp    DateTime @default(now())
 *   
 *   usuario      Usuario  @relation(fields: [userId], references: [id])
 *   
 *   @@index([userId])
 *   @@index([recursoTipo, recursoId])
 *   @@index([tenantId, timestamp])
 * }
 */

export default {
  AuthService,
  JwtAuthGuard,
  RolesGuard,
  PermissionsGuard,
  TenancyGuard,
  AuditoriaService,
  AuditoriaInterceptor,
  Role,
  Permission,
  AccionAuditoria,
  Roles,
  RequirePermissions,
  Public,
  CurrentUser,
  Auditable,
};
