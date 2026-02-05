"""
OSINT Media Monitoring - Módulo de Web Crawling y Análisis de Sentimiento
Sistema de scraping de noticias y redes sociales con detección de tendencias

Stack: Python + Scrapy/BeautifulSoup + Transformers + Redis
Autor: Sistema LEXA/OSINT
"""

import asyncio
import logging
import re
from typing import List, Dict, Optional, Set, Tuple
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from collections import Counter, defaultdict
from enum import Enum

# Web Scraping
import aiohttp
from bs4 import BeautifulSoup
from scrapy import Spider, Request
from scrapy.crawler import CrawlerProcess

# NLP y Análisis de Sentimiento
from transformers import pipeline, AutoTokenizer, AutoModelForSequenceClassification
import torch
from textblob import TextBlob
import spacy

# Análisis de tendencias
import pandas as pd
import numpy as np
from scipy import stats

# Redis para caché y trending
import redis
import json

# APIs de redes sociales (simuladas)
import tweepy  # Twitter
from facebook_scraper import get_posts  # Facebook

# ============================================
# CONFIGURACIÓN Y TIPOS
# ============================================

class Polaridad(Enum):
    POSITIVO = "positivo"
    NEGATIVO = "negativo"
    NEUTRAL = "neutral"

class Emocion(Enum):
    ENOJO = "enojo"
    MIEDO = "miedo"
    ALEGRIA = "alegría"
    TRISTEZA = "tristeza"
    SORPRESA = "sorpresa"
    DISGUSTO = "disgusto"

class FuenteNoticia(Enum):
    CLARIN = "clarin"
    LA_NACION = "lanacion"
    PAGINA12 = "pagina12"
    INFOBAE = "infobae"
    AMBITO = "ambito"
    PERFIL = "perfil"
    CRONISTA = "cronista"

@dataclass
class Articulo:
    """Artículo de noticia"""
    id: str
    url: str
    fuente: str
    titulo: str
    contenido: str
    fecha_publicacion: datetime
    autor: Optional[str] = None
    categoria: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    
    # Análisis
    sentimiento: Optional[Polaridad] = None
    emociones: Dict[Emocion, float] = field(default_factory=dict)
    score_sentimiento: float = 0.0  # -1 a 1
    
    # Metadata
    shares: int = 0
    comentarios: int = 0
    vistas: int = 0

@dataclass
class TrendingTopic:
    """Tema en tendencia"""
    hashtag: str
    menciones: int
    crecimiento_24h: float  # % crecimiento
    velocidad: float  # menciones/hora
    sentimiento_promedio: float
    emociones_dominantes: List[Emocion]
    articulos_relacionados: List[str]
    probabilidad_viral: float  # 0-1
    timestamp: datetime

@dataclass
class AnalisisColectivo:
    """Análisis de emociones colectivas"""
    periodo: str  # "24h", "7d", "30d"
    distribucion_emociones: Dict[Emocion, float]
    polaridad_dominante: Polaridad
    temas_calientes: List[TrendingTopic]
    nivel_tension_social: float  # 0-100
    indicadores_conflicto: List[str]

# ============================================
# CONFIGURACIÓN DE FUENTES
# ============================================

PORTALES_ARGENTINA = {
    FuenteNoticia.CLARIN: {
        "url": "https://www.clarin.com",
        "selectors": {
            "titular": "h1.title",
            "contenido": "div.body-nota",
            "fecha": "time.date",
            "autor": "span.author"
        }
    },
    FuenteNoticia.LA_NACION: {
        "url": "https://www.lanacion.com.ar",
        "selectors": {
            "titular": "h1.com-title",
            "contenido": "section.article-body",
            "fecha": "time.com-date",
            "autor": "span.com-author"
        }
    },
    FuenteNoticia.INFOBAE: {
        "url": "https://www.infobae.com",
        "selectors": {
            "titular": "h1.headline",
            "contenido": "div.article-content",
            "fecha": "time.date",
            "autor": "span.author-name"
        }
    },
    FuenteNoticia.PAGINA12: {
        "url": "https://www.pagina12.com.ar",
        "selectors": {
            "titular": "h1.article-title",
            "contenido": "div.article-text",
            "fecha": "time.date",
            "autor": "span.author"
        }
    }
}

# ============================================
# SERVICIO PRINCIPAL
# ============================================

class MediaCrawlerAndSentimentAnalyzer:
    """Sistema de crawling y análisis de sentimiento"""
    
    def __init__(self):
        self.logger = self._setup_logging()
        self._init_nlp_models()
        self._init_redis()
        self.session = None
        
        self.logger.info("Crawler inicializado")
    
    def _setup_logging(self) -> logging.Logger:
        """Configurar logging"""
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        return logging.getLogger(__name__)
    
    def _init_nlp_models(self):
        """Inicializar modelos de NLP"""
        self.logger.info("Cargando modelos de NLP...")
        
        # Modelo de sentimiento en español
        self.sentiment_analyzer = pipeline(
            "sentiment-analysis",
            model="finiteautomata/beto-sentiment-analysis"
        )
        
        # Modelo de emociones
        self.emotion_analyzer = pipeline(
            "text-classification",
            model="joeddav/distilbert-base-uncased-go-emotions-student",
            return_all_scores=True
        )
        
        # SpaCy para procesamiento de texto
        try:
            self.nlp = spacy.load("es_core_news_sm")
        except:
            self.logger.warning("Modelo spacy no encontrado. Ejecutar: python -m spacy download es_core_news_sm")
            self.nlp = None
        
        self.logger.info("Modelos NLP cargados")
    
    def _init_redis(self):
        """Inicializar Redis para tracking de tendencias"""
        self.redis_client = redis.Redis(
            host=os.getenv("REDIS_HOST", "localhost"),
            port=int(os.getenv("REDIS_PORT", 6379)),
            db=0,
            decode_responses=True
        )
        self.logger.info("Redis inicializado")
    
    # ============================================
    # WEB SCRAPING
    # ============================================
    
    async def scrape_news_portal(
        self,
        fuente: FuenteNoticia,
        max_articles: int = 50
    ) -> List[Articulo]:
        """Scrape noticias de un portal"""
        self.logger.info(f"Scrapeando {fuente.value}...")
        
        config = PORTALES_ARGENTINA[fuente]
        
        if not self.session:
            self.session = aiohttp.ClientSession()
        
        # Obtener página principal
        async with self.session.get(config["url"]) as response:
            html = await response.text()
        
        soup = BeautifulSoup(html, 'html.parser')
        
        # Extraer enlaces a artículos
        article_links = self._extract_article_links(soup, config["url"])
        article_links = article_links[:max_articles]
        
        # Scrape cada artículo
        articulos = []
        for link in article_links:
            try:
                articulo = await self._scrape_article(link, fuente, config)
                if articulo:
                    articulos.append(articulo)
                await asyncio.sleep(0.5)  # Rate limiting
            except Exception as e:
                self.logger.error(f"Error scrapeando {link}: {e}")
        
        self.logger.info(f"Scrapeados {len(articulos)} artículos de {fuente.value}")
        return articulos
    
    def _extract_article_links(self, soup: BeautifulSoup, base_url: str) -> List[str]:
        """Extraer enlaces a artículos"""
        links = []
        
        # Buscar enlaces en tags comunes
        for tag in soup.find_all(['a', 'h2', 'h3']):
            link = tag.get('href')
            if link:
                # Normalizar URL
                if link.startswith('/'):
                    link = base_url + link
                elif not link.startswith('http'):
                    continue
                
                # Filtrar enlaces relevantes
                if any(keyword in link for keyword in ['/nota/', '/noticia/', '/articulo/', '/politica/', '/economia/']):
                    if link not in links:
                        links.append(link)
        
        return links
    
    async def _scrape_article(
        self,
        url: str,
        fuente: FuenteNoticia,
        config: Dict
    ) -> Optional[Articulo]:
        """Scrape un artículo individual"""
        
        async with self.session.get(url) as response:
            if response.status != 200:
                return None
            html = await response.text()
        
        soup = BeautifulSoup(html, 'html.parser')
        selectors = config["selectors"]
        
        # Extraer datos
        titulo_tag = soup.select_one(selectors["titular"])
        contenido_tag = soup.select_one(selectors["contenido"])
        fecha_tag = soup.select_one(selectors["fecha"])
        autor_tag = soup.select_one(selectors["autor"])
        
        if not titulo_tag or not contenido_tag:
            return None
        
        titulo = titulo_tag.get_text(strip=True)
        contenido = contenido_tag.get_text(strip=True, separator=' ')
        
        # Limpiar contenido
        contenido = self._clean_text(contenido)
        
        # Parsear fecha
        fecha_str = fecha_tag.get_text(strip=True) if fecha_tag else None
        fecha = self._parse_date(fecha_str) if fecha_str else datetime.now()
        
        autor = autor_tag.get_text(strip=True) if autor_tag else None
        
        # Crear artículo
        articulo = Articulo(
            id=f"{fuente.value}_{hash(url)}",
            url=url,
            fuente=fuente.value,
            titulo=titulo,
            contenido=contenido,
            fecha_publicacion=fecha,
            autor=autor
        )
        
        return articulo
    
    def _clean_text(self, text: str) -> str:
        """Limpiar texto"""
        # Remover múltiples espacios
        text = re.sub(r'\s+', ' ', text)
        # Remover caracteres especiales
        text = re.sub(r'[^\w\s.,;:¿?¡!áéíóúñÁÉÍÓÚÑ-]', '', text)
        return text.strip()
    
    def _parse_date(self, date_str: str) -> datetime:
        """Parsear fecha del artículo"""
        # Implementación simplificada
        # En producción, usar dateutil.parser
        try:
            return datetime.strptime(date_str, "%d/%m/%Y")
        except:
            return datetime.now()
    
    # ============================================
    # ANÁLISIS DE SENTIMIENTO
    # ============================================
    
    async def analyze_sentiment(self, articulo: Articulo) -> Articulo:
        """Analizar sentimiento de un artículo"""
        
        # Análisis de sentimiento principal
        sentiment_result = self.sentiment_analyzer(articulo.titulo + ". " + articulo.contenido[:500])
        
        # Mapear resultado
        label = sentiment_result[0]['label'].lower()
        score = sentiment_result[0]['score']
        
        if 'pos' in label or 'positive' in label:
            articulo.sentimiento = Polaridad.POSITIVO
            articulo.score_sentimiento = score
        elif 'neg' in label or 'negative' in label:
            articulo.sentimiento = Polaridad.NEGATIVO
            articulo.score_sentimiento = -score
        else:
            articulo.sentimiento = Polaridad.NEUTRAL
            articulo.score_sentimiento = 0.0
        
        # Análisis de emociones
        articulo.emociones = await self._analyze_emotions(articulo.contenido)
        
        self.logger.debug(f"Sentimiento analizado: {articulo.sentimiento.value} ({articulo.score_sentimiento:.2f})")
        
        return articulo
    
    async def _analyze_emotions(self, text: str) -> Dict[Emocion, float]:
        """Analizar emociones en el texto"""
        
        # Truncar texto
        text = text[:512]
        
        emotion_results = self.emotion_analyzer(text)[0]
        
        # Mapear emociones
        emotion_map = {
            'anger': Emocion.ENOJO,
            'fear': Emocion.MIEDO,
            'joy': Emocion.ALEGRIA,
            'sadness': Emocion.TRISTEZA,
            'surprise': Emocion.SORPRESA,
            'disgust': Emocion.DISGUSTO
        }
        
        emociones = {}
        for result in emotion_results:
            label = result['label']
            if label in emotion_map:
                emociones[emotion_map[label]] = result['score']
        
        return emociones
    
    # ============================================
    # DETECCIÓN DE TENDENCIAS
    # ============================================
    
    async def extract_hashtags_and_trends(
        self,
        articulos: List[Articulo]
    ) -> List[TrendingTopic]:
        """Extraer hashtags y detectar tendencias"""
        self.logger.info("Extrayendo hashtags y tendencias...")
        
        # Extraer todos los hashtags
        all_hashtags = []
        for articulo in articulos:
            hashtags = self._extract_hashtags(articulo.titulo + " " + articulo.contenido)
            all_hashtags.extend(hashtags)
            articulo.tags = hashtags
        
        # Contar menciones
        hashtag_counts = Counter(all_hashtags)
        
        # Analizar cada hashtag
        trending_topics = []
        for hashtag, count in hashtag_counts.most_common(20):
            
            # Calcular métricas de tendencia
            trending = await self._analyze_trend(hashtag, count, articulos)
            
            if trending:
                trending_topics.append(trending)
        
        # Ordenar por probabilidad viral
        trending_topics.sort(key=lambda x: x.probabilidad_viral, reverse=True)
        
        self.logger.info(f"Identificadas {len(trending_topics)} tendencias")
        return trending_topics
    
    def _extract_hashtags(self, text: str) -> List[str]:
        """Extraer hashtags del texto"""
        # Extraer hashtags explícitos
        hashtags = re.findall(r'#\w+', text.lower())
        
        # Extraer keywords importantes (sin NLP si spacy no está disponible)
        if self.nlp:
            doc = self.nlp(text.lower())
            # Extraer entidades y sustantivos importantes
            for ent in doc.ents:
                if ent.label_ in ['PER', 'ORG', 'LOC', 'MISC']:
                    hashtags.append('#' + ent.text.replace(' ', '_'))
            
            for token in doc:
                if token.pos_ == 'PROPN' and len(token.text) > 3:
                    hashtags.append('#' + token.text)
        
        return list(set(hashtags))  # Unique
    
    async def _analyze_trend(
        self,
        hashtag: str,
        menciones_actuales: int,
        articulos: List[Articulo]
    ) -> Optional[TrendingTopic]:
        """Analizar si un hashtag es tendencia"""
        
        # Obtener métricas históricas de Redis
        redis_key = f"hashtag:{hashtag}"
        
        # Obtener conteo previo (24h atrás)
        menciones_previas = self.redis_client.get(f"{redis_key}:24h")
        menciones_previas = int(menciones_previas) if menciones_previas else 0
        
        # Calcular crecimiento
        if menciones_previas > 0:
            crecimiento = ((menciones_actuales - menciones_previas) / menciones_previas) * 100
        else:
            crecimiento = 100 if menciones_actuales > 5 else 0
        
        # Calcular velocidad (menciones/hora)
        velocidad = menciones_actuales / 24  # Asumiendo ventana de 24h
        
        # Filtrar artículos relacionados
        articulos_relacionados = [
            a.id for a in articulos
            if hashtag in (a.titulo + " " + a.contenido).lower()
        ]
        
        # Sentimiento promedio
        sentimientos = [
            a.score_sentimiento for a in articulos
            if hashtag in (a.titulo + " " + a.contenido).lower()
        ]
        sentimiento_promedio = np.mean(sentimientos) if sentimientos else 0.0
        
        # Emociones dominantes
        all_emociones = defaultdict(list)
        for articulo in articulos:
            if hashtag in (articulo.titulo + " " + articulo.contenido).lower():
                for emocion, score in articulo.emociones.items():
                    all_emociones[emocion].append(score)
        
        emociones_promedio = {
            emocion: np.mean(scores)
            for emocion, scores in all_emociones.items()
        }
        emociones_dominantes = sorted(
            emociones_promedio.items(),
            key=lambda x: x[1],
            reverse=True
        )[:3]
        
        # Calcular probabilidad viral
        probabilidad_viral = self._calculate_viral_probability(
            menciones_actuales,
            crecimiento,
            velocidad,
            abs(sentimiento_promedio)
        )
        
        # Guardar métricas actuales en Redis
        self.redis_client.setex(redis_key, 86400, menciones_actuales)  # TTL 24h
        
        # Solo retornar si tiene potencial viral
        if probabilidad_viral > 0.3 or crecimiento > 50:
            return TrendingTopic(
                hashtag=hashtag,
                menciones=menciones_actuales,
                crecimiento_24h=crecimiento,
                velocidad=velocidad,
                sentimiento_promedio=sentimiento_promedio,
                emociones_dominantes=[e[0] for e in emociones_dominantes],
                articulos_relacionados=articulos_relacionados,
                probabilidad_viral=probabilidad_viral,
                timestamp=datetime.now()
            )
        
        return None
    
    def _calculate_viral_probability(
        self,
        menciones: int,
        crecimiento: float,
        velocidad: float,
        intensidad_sentimiento: float
    ) -> float:
        """Calcular probabilidad de volverse viral"""
        
        # Normalizar métricas (0-1)
        norm_menciones = min(menciones / 100, 1.0)
        norm_crecimiento = min(crecimiento / 200, 1.0)
        norm_velocidad = min(velocidad / 10, 1.0)
        norm_sentimiento = intensidad_sentimiento  # Ya está 0-1
        
        # Ponderación
        probabilidad = (
            norm_menciones * 0.3 +
            norm_crecimiento * 0.35 +
            norm_velocidad * 0.25 +
            norm_sentimiento * 0.10
        )
        
        return min(probabilidad, 1.0)
    
    # ============================================
    # ANÁLISIS COLECTIVO
    # ============================================
    
    async def analyze_collective_sentiment(
        self,
        articulos: List[Articulo],
        trending_topics: List[TrendingTopic]
    ) -> AnalisisColectivo:
        """Analizar emociones colectivas y tensión social"""
        self.logger.info("Analizando sentimiento colectivo...")
        
        # Distribución de emociones
        all_emociones = defaultdict(list)
        for articulo in articulos:
            for emocion, score in articulo.emociones.items():
                all_emociones[emocion].append(score)
        
        distribucion_emociones = {
            emocion: np.mean(scores)
            for emocion, scores in all_emociones.items()
        }
        
        # Polaridad dominante
        sentimientos = [a.sentimiento for a in articulos]
        polaridad_dominante = Counter(sentimientos).most_common(1)[0][0]
        
        # Nivel de tensión social
        nivel_tension = self._calculate_social_tension(articulos, trending_topics)
        
        # Indicadores de conflicto
        indicadores = self._detect_conflict_indicators(articulos, trending_topics)
        
        return AnalisisColectivo(
            periodo="24h",
            distribucion_emociones=distribucion_emociones,
            polaridad_dominante=polaridad_dominante,
            temas_calientes=trending_topics[:10],
            nivel_tension_social=nivel_tension,
            indicadores_conflicto=indicadores
        )
    
    def _calculate_social_tension(
        self,
        articulos: List[Articulo],
        trending_topics: List[TrendingTopic]
    ) -> float:
        """Calcular nivel de tensión social (0-100)"""
        
        # Factores de tensión
        emociones_negativas = ['enojo', 'miedo', 'tristeza', 'disgusto']
        
        # % artículos con sentimiento negativo
        negativos = sum(1 for a in articulos if a.sentimiento == Polaridad.NEGATIVO)
        ratio_negativos = negativos / len(articulos) if articulos else 0
        
        # Intensidad de emociones negativas
        intensidad_negativa = 0
        for articulo in articulos:
            for emocion, score in articulo.emociones.items():
                if emocion.value in emociones_negativas:
                    intensidad_negativa += score
        intensidad_negativa /= len(articulos) if articulos else 1
        
        # Trending topics con alto crecimiento
        trending_explosivo = sum(
            1 for t in trending_topics
            if t.crecimiento_24h > 100
        )
        ratio_explosivo = trending_explosivo / len(trending_topics) if trending_topics else 0
        
        # Calcular tensión (0-100)
        tension = (
            ratio_negativos * 40 +
            intensidad_negativa * 30 +
            ratio_explosivo * 30
        ) * 100
        
        return min(tension, 100.0)
    
    def _detect_conflict_indicators(
        self,
        articulos: List[Articulo],
        trending_topics: List[TrendingTopic]
    ) -> List[str]:
        """Detectar indicadores de conflicto"""
        
        indicadores = []
        
        # Keywords de conflicto
        conflict_keywords = [
            'protesta', 'manifestación', 'paro', 'huelga', 'reclamo',
            'crisis', 'conflicto', 'tensión', 'enfrentamiento',
            'violencia', 'represión', 'descontento', 'indignación'
        ]
        
        # Buscar en trending topics
        for topic in trending_topics[:10]:
            for keyword in conflict_keywords:
                if keyword in topic.hashtag.lower():
                    indicadores.append(
                        f"Trending: {topic.hashtag} ({topic.menciones} menciones, +{topic.crecimiento_24h:.0f}%)"
                    )
                    break
        
        # Buscar en titulares
        titulares_conflicto = 0
        for articulo in articulos:
            for keyword in conflict_keywords:
                if keyword in articulo.titulo.lower():
                    titulares_conflicto += 1
                    break
        
        if titulares_conflicto > len(articulos) * 0.2:
            indicadores.append(
                f"{titulares_conflicto} artículos mencionan conflicto ({titulares_conflicto/len(articulos)*100:.1f}%)"
            )
        
        return indicadores
    
    # ============================================
    # ORQUESTACIÓN
    # ============================================
    
    async def run_full_analysis(self) -> Dict:
        """Ejecutar análisis completo"""
        self.logger.info("Iniciando análisis completo...")
        
        # 1. Scrape todos los portales
        all_articulos = []
        for fuente in FuenteNoticia:
            try:
                articulos = await self.scrape_news_portal(fuente, max_articles=30)
                all_articulos.extend(articulos)
            except Exception as e:
                self.logger.error(f"Error scrapeando {fuente.value}: {e}")
        
        self.logger.info(f"Total artículos scrapeados: {len(all_articulos)}")
        
        # 2. Analizar sentimiento de cada artículo
        for articulo in all_articulos:
            await self.analyze_sentiment(articulo)
        
        # 3. Detectar tendencias
        trending_topics = await self.extract_hashtags_and_trends(all_articulos)
        
        # 4. Análisis colectivo
        analisis_colectivo = await self.analyze_collective_sentiment(
            all_articulos,
            trending_topics
        )
        
        return {
            "articulos": all_articulos,
            "trending_topics": trending_topics,
            "analisis_colectivo": analisis_colectivo,
            "timestamp": datetime.now()
        }
    
    async def close(self):
        """Cerrar recursos"""
        if self.session:
            await self.session.close()


# ============================================
# EJEMPLO DE USO
# ============================================

async def main():
    """Ejemplo de uso"""
    
    import os
    os.environ.setdefault('REDIS_HOST', 'localhost')
    
    crawler = MediaCrawlerAndSentimentAnalyzer()
    
    # Ejecutar análisis completo
    resultados = await crawler.run_full_analysis()
    
    # Mostrar resultados
    print(f"\n{'='*80}")
    print("ANÁLISIS DE MEDIOS Y SENTIMIENTO")
    print(f"{'='*80}")
    
    print(f"\n📰 Artículos analizados: {len(resultados['articulos'])}")
    
    # Distribución de sentimientos
    sentimientos = Counter([a.sentimiento for a in resultados['articulos']])
    print(f"\n📊 Distribución de Sentimientos:")
    for sentimiento, count in sentimientos.items():
        porcentaje = (count / len(resultados['articulos'])) * 100
        print(f"   {sentimiento.value.capitalize()}: {count} ({porcentaje:.1f}%)")
    
    # Trending topics
    print(f"\n🔥 Top 10 Trending Topics:")
    for i, topic in enumerate(resultados['trending_topics'][:10], 1):
        emoji = "🚀" if topic.probabilidad_viral > 0.7 else "📈"
        print(f"   {i}. {emoji} {topic.hashtag}")
        print(f"      Menciones: {topic.menciones} | Crecimiento: +{topic.crecimiento_24h:.0f}%")
        print(f"      Probabilidad viral: {topic.probabilidad_viral:.0%}")
        print(f"      Emociones: {', '.join([e.value for e in topic.emociones_dominantes[:2]])}")
    
    # Análisis colectivo
    analisis = resultados['analisis_colectivo']
    print(f"\n😡 Emociones Colectivas:")
    for emocion, score in sorted(analisis.distribucion_emociones.items(), key=lambda x: x[1], reverse=True):
        print(f"   {emocion.value.capitalize()}: {score:.2%}")
    
    print(f"\n⚠️  Nivel de Tensión Social: {analisis.nivel_tension_social:.1f}/100")
    
    if analisis.indicadores_conflicto:
        print(f"\n🔴 Indicadores de Conflicto:")
        for indicador in analisis.indicadores_conflicto:
            print(f"   - {indicador}")
    
    await crawler.close()


if __name__ == "__main__":
    asyncio.run(main())
