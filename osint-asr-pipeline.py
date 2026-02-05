"""
OSINT Media Monitoring - Módulo de Transcripción y Clasificación (ASR)
Sistema de procesamiento de audio/video para escucha de medios

Stack: Python + Whisper/Google Speech + Transformers + Pinecone/pgvector
Autor: Sistema LEXA/OSINT
"""

import os
import asyncio
import logging
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime
from enum import Enum

# ASR y procesamiento de audio
import whisper
from pydub import AudioSegment
from google.cloud import speech_v1
from google.cloud.speech_v1 import types

# NLP y clasificación
from transformers import (
    pipeline,
    AutoTokenizer,
    AutoModelForTokenClassification,
    AutoModelForSequenceClassification
)

# Vector Database
import pinecone
from sentence_transformers import SentenceTransformer
import psycopg2
from pgvector.psycopg2 import register_vector

# Utilidades
import ffmpeg
import numpy as np
from urllib.parse import urlparse

# ============================================
# CONFIGURACIÓN Y TIPOS
# ============================================

class TemasCriticos(Enum):
    POLITICA = "política"
    SEGURIDAD = "seguridad"
    ECONOMIA = "economía"
    SOCIAL = "social"
    INTERNACIONAL = "internacional"
    SALUD = "salud"
    MEDIO_AMBIENTE = "medio_ambiente"
    TECNOLOGIA = "tecnología"
    JUSTICIA = "justicia"
    EDUCACION = "educación"

class ASRProvider(Enum):
    WHISPER = "whisper"
    GOOGLE = "google"
    ASSEMBLY = "assembly"

@dataclass
class AudioSource:
    """Fuente de audio a procesar"""
    id: str
    url: str
    source_type: str  # radio, tv, podcast, youtube
    channel_name: str
    start_time: datetime
    duration_seconds: Optional[int] = None
    metadata: Optional[Dict] = None

@dataclass
class TranscriptionSegment:
    """Segmento de transcripción"""
    text: str
    start_time: float
    end_time: float
    confidence: float
    speaker_id: Optional[str] = None

@dataclass
class Actor:
    """Actor clave identificado"""
    name: str
    type: str  # politician, journalist, businessman, celebrity
    mentions: int
    sentiment: str  # positive, negative, neutral
    quotes: List[str]

@dataclass
class ProcessedAudio:
    """Resultado del procesamiento completo"""
    source: AudioSource
    transcription: str
    segments: List[TranscriptionSegment]
    temas: List[TemasCriticos]
    actors: List[Actor]
    keywords: List[str]
    embeddings: np.ndarray
    processed_at: datetime

# ============================================
# SERVICIO PRINCIPAL
# ============================================

class MediaMonitoringASRPipeline:
    """Pipeline completo de procesamiento de audio"""
    
    def __init__(
        self,
        asr_provider: ASRProvider = ASRProvider.WHISPER,
        vector_db_type: str = "pinecone",  # "pinecone" o "pgvector"
        model_size: str = "medium"  # tiny, base, small, medium, large
    ):
        self.asr_provider = asr_provider
        self.vector_db_type = vector_db_type
        self.logger = self._setup_logging()
        
        # Inicializar modelos
        self._init_asr_engine(model_size)
        self._init_nlp_models()
        self._init_vector_db()
        
        self.logger.info(f"Pipeline inicializado con {asr_provider.value}")
    
    def _setup_logging(self) -> logging.Logger:
        """Configurar logging"""
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        return logging.getLogger(__name__)
    
    def _init_asr_engine(self, model_size: str):
        """Inicializar motor de ASR"""
        if self.asr_provider == ASRProvider.WHISPER:
            self.logger.info(f"Cargando Whisper modelo: {model_size}")
            self.whisper_model = whisper.load_model(model_size)
            
        elif self.asr_provider == ASRProvider.GOOGLE:
            self.google_client = speech_v1.SpeechClient()
            self.logger.info("Google Speech-to-Text inicializado")
    
    def _init_nlp_models(self):
        """Inicializar modelos de NLP"""
        self.logger.info("Cargando modelos de NLP...")
        
        # Named Entity Recognition (NER) - Para actores clave
        self.ner_model = pipeline(
            "ner",
            model="dslim/bert-base-NER",
            aggregation_strategy="simple"
        )
        
        # Text Classification - Para temas críticos
        self.classifier = pipeline(
            "zero-shot-classification",
            model="facebook/bart-large-mnli"
        )
        
        # Sentence embeddings - Para búsqueda semántica
        self.embedder = SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2')
        
        self.logger.info("Modelos NLP cargados")
    
    def _init_vector_db(self):
        """Inicializar base de datos vectorial"""
        if self.vector_db_type == "pinecone":
            pinecone.init(
                api_key=os.getenv("PINECONE_API_KEY"),
                environment=os.getenv("PINECONE_ENV")
            )
            
            index_name = "media-monitoring"
            if index_name not in pinecone.list_indexes():
                pinecone.create_index(
                    name=index_name,
                    dimension=384,  # Dimensión del modelo de embeddings
                    metric="cosine"
                )
            
            self.vector_index = pinecone.Index(index_name)
            self.logger.info("Pinecone inicializado")
            
        elif self.vector_db_type == "pgvector":
            self.pg_conn = psycopg2.connect(
                host=os.getenv("POSTGRES_HOST"),
                database=os.getenv("POSTGRES_DB"),
                user=os.getenv("POSTGRES_USER"),
                password=os.getenv("POSTGRES_PASSWORD")
            )
            register_vector(self.pg_conn)
            self._setup_pgvector_schema()
            self.logger.info("pgvector inicializado")
    
    def _setup_pgvector_schema(self):
        """Crear schema para pgvector"""
        with self.pg_conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS audio_transcriptions (
                    id SERIAL PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    channel_name TEXT,
                    transcription TEXT,
                    temas TEXT[],
                    actors JSONB,
                    keywords TEXT[],
                    embedding vector(384),
                    processed_at TIMESTAMP DEFAULT NOW(),
                    metadata JSONB
                )
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS embedding_idx 
                ON audio_transcriptions 
                USING ivfflat (embedding vector_cosine_ops)
            """)
            self.pg_conn.commit()
    
    # ============================================
    # PIPELINE PRINCIPAL
    # ============================================
    
    async def process_audio_stream(
        self,
        source: AudioSource,
        stream_url: Optional[str] = None
    ) -> ProcessedAudio:
        """
        Procesa un stream de audio completo
        """
        self.logger.info(f"Procesando audio: {source.channel_name}")
        
        # 1. Descargar/capturar audio
        audio_path = await self._download_audio(source.url)
        
        # 2. Preprocesar audio
        processed_audio_path = self._preprocess_audio(audio_path)
        
        # 3. Transcribir con ASR
        transcription, segments = await self._transcribe_audio(processed_audio_path)
        
        # 4. Análisis NLP
        temas = self._classify_topics(transcription)
        actors = self._extract_actors(transcription)
        keywords = self._extract_keywords(transcription)
        
        # 5. Generar embeddings
        embeddings = self._generate_embeddings(transcription)
        
        # 6. Almacenar en vector DB
        processed = ProcessedAudio(
            source=source,
            transcription=transcription,
            segments=segments,
            temas=temas,
            actors=actors,
            keywords=keywords,
            embeddings=embeddings,
            processed_at=datetime.now()
        )
        
        await self._store_in_vector_db(processed)
        
        self.logger.info(f"Audio procesado: {len(segments)} segmentos")
        return processed
    
    # ============================================
    # TRANSCRIPCIÓN
    # ============================================
    
    async def _download_audio(self, url: str) -> str:
        """Descargar audio desde URL"""
        output_path = f"/tmp/audio_{datetime.now().timestamp()}.mp3"
        
        try:
            # Usar ffmpeg para capturar stream
            stream = ffmpeg.input(url)
            stream = ffmpeg.output(stream, output_path, acodec='mp3', ac=1, ar='16000')
            ffmpeg.run(stream, capture_stdout=True, capture_stderr=True)
            
            self.logger.info(f"Audio descargado: {output_path}")
            return output_path
            
        except Exception as e:
            self.logger.error(f"Error descargando audio: {e}")
            raise
    
    def _preprocess_audio(self, audio_path: str) -> str:
        """Preprocesar audio para mejorar transcripción"""
        self.logger.info("Preprocesando audio...")
        
        # Cargar audio
        audio = AudioSegment.from_file(audio_path)
        
        # Normalizar volumen
        audio = audio.normalize()
        
        # Reducir ruido (filtro simple)
        audio = audio.low_pass_filter(3000).high_pass_filter(200)
        
        # Convertir a mono y 16kHz
        audio = audio.set_channels(1)
        audio = audio.set_frame_rate(16000)
        
        # Guardar audio procesado
        processed_path = audio_path.replace('.mp3', '_processed.wav')
        audio.export(processed_path, format='wav')
        
        return processed_path
    
    async def _transcribe_audio(
        self, audio_path: str
    ) -> Tuple[str, List[TranscriptionSegment]]:
        """Transcribir audio a texto"""
        
        if self.asr_provider == ASRProvider.WHISPER:
            return await self._transcribe_whisper(audio_path)
        elif self.asr_provider == ASRProvider.GOOGLE:
            return await self._transcribe_google(audio_path)
        else:
            raise ValueError(f"ASR provider no soportado: {self.asr_provider}")
    
    async def _transcribe_whisper(
        self, audio_path: str
    ) -> Tuple[str, List[TranscriptionSegment]]:
        """Transcribir con Whisper"""
        self.logger.info("Transcribiendo con Whisper...")
        
        result = self.whisper_model.transcribe(
            audio_path,
            language="es",  # Español
            task="transcribe",
            verbose=False,
            word_timestamps=True
        )
        
        # Extraer texto completo
        transcription = result["text"]
        
        # Extraer segmentos
        segments = []
        for seg in result.get("segments", []):
            segments.append(TranscriptionSegment(
                text=seg["text"].strip(),
                start_time=seg["start"],
                end_time=seg["end"],
                confidence=seg.get("avg_logprob", 0.0)
            ))
        
        self.logger.info(f"Transcripción completada: {len(transcription)} caracteres")
        return transcription, segments
    
    async def _transcribe_google(
        self, audio_path: str
    ) -> Tuple[str, List[TranscriptionSegment]]:
        """Transcribir con Google Speech-to-Text"""
        self.logger.info("Transcribiendo con Google Speech-to-Text...")
        
        with open(audio_path, 'rb') as f:
            audio_content = f.read()
        
        audio = types.RecognitionAudio(content=audio_content)
        config = types.RecognitionConfig(
            encoding=speech_v1.RecognitionConfig.AudioEncoding.LINEAR16,
            sample_rate_hertz=16000,
            language_code="es-AR",  # Español Argentina
            enable_word_time_offsets=True,
            enable_automatic_punctuation=True,
            model="latest_long"
        )
        
        response = self.google_client.recognize(config=config, audio=audio)
        
        transcription = ""
        segments = []
        
        for result in response.results:
            alt = result.alternatives[0]
            transcription += alt.transcript + " "
            
            if alt.words:
                segment_text = []
                start = None
                end = None
                
                for word_info in alt.words:
                    if start is None:
                        start = word_info.start_time.total_seconds()
                    end = word_info.end_time.total_seconds()
                    segment_text.append(word_info.word)
                
                segments.append(TranscriptionSegment(
                    text=" ".join(segment_text),
                    start_time=start,
                    end_time=end,
                    confidence=alt.confidence
                ))
        
        return transcription.strip(), segments
    
    # ============================================
    # ANÁLISIS NLP
    # ============================================
    
    def _classify_topics(self, text: str) -> List[TemasCriticos]:
        """Clasificar texto en temas críticos"""
        self.logger.info("Clasificando temas...")
        
        candidate_labels = [tema.value for tema in TemasCriticos]
        
        result = self.classifier(
            text[:1000],  # Limitar a primeros 1000 chars
            candidate_labels,
            multi_label=True
        )
        
        # Filtrar temas con confianza > 0.3
        temas = [
            TemasCriticos(label)
            for label, score in zip(result['labels'], result['scores'])
            if score > 0.3
        ]
        
        self.logger.info(f"Temas identificados: {[t.value for t in temas]}")
        return temas
    
    def _extract_actors(self, text: str) -> List[Actor]:
        """Extraer actores clave del texto"""
        self.logger.info("Extrayendo actores clave...")
        
        # NER para identificar personas
        entities = self.ner_model(text)
        
        # Filtrar solo personas
        actors_dict = {}
        for entity in entities:
            if entity['entity_group'] == 'PER':
                name = entity['word']
                if name not in actors_dict:
                    actors_dict[name] = {
                        'mentions': 0,
                        'quotes': []
                    }
                actors_dict[name]['mentions'] += 1
        
        # Extraer citas (texto entre comillas)
        import re
        quotes = re.findall(r'"([^"]*)"', text)
        
        # Asociar citas con actores (búsqueda simple)
        for name in actors_dict.keys():
            for quote in quotes:
                if name.lower() in text[max(0, text.find(quote)-100):text.find(quote)].lower():
                    actors_dict[name]['quotes'].append(quote)
        
        # Convertir a lista de Actor
        actors = [
            Actor(
                name=name,
                type="unknown",  # Clasificación adicional puede agregarse
                mentions=data['mentions'],
                sentiment="neutral",  # Análisis de sentimiento puede agregarse
                quotes=data['quotes'][:3]  # Top 3 citas
            )
            for name, data in sorted(
                actors_dict.items(),
                key=lambda x: x[1]['mentions'],
                reverse=True
            )[:10]  # Top 10 actores
        ]
        
        self.logger.info(f"Actores identificados: {len(actors)}")
        return actors
    
    def _extract_keywords(self, text: str) -> List[str]:
        """Extraer keywords relevantes"""
        from collections import Counter
        import re
        
        # Tokenizar y limpiar
        words = re.findall(r'\b[a-záéíóúñ]{4,}\b', text.lower())
        
        # Stopwords español
        stopwords = set([
            'este', 'esta', 'estos', 'estas', 'aquel', 'aquella', 'aquellos',
            'aquellas', 'cual', 'cuales', 'quien', 'quienes', 'todo', 'todos',
            'toda', 'todas', 'pero', 'porque', 'cuando', 'donde', 'como',
            'para', 'desde', 'hasta', 'contra', 'entre', 'sobre', 'según',
            'tiene', 'hacer', 'hacer', 'estar', 'poder', 'decir', 'tener'
        ])
        
        # Filtrar stopwords
        words = [w for w in words if w not in stopwords]
        
        # Top 20 palabras más frecuentes
        counter = Counter(words)
        keywords = [word for word, _ in counter.most_common(20)]
        
        return keywords
    
    def _generate_embeddings(self, text: str) -> np.ndarray:
        """Generar embeddings para búsqueda semántica"""
        self.logger.info("Generando embeddings...")
        
        # Truncar texto si es muy largo
        max_length = 5000
        if len(text) > max_length:
            text = text[:max_length]
        
        embeddings = self.embedder.encode(text)
        return embeddings
    
    # ============================================
    # ALMACENAMIENTO
    # ============================================
    
    async def _store_in_vector_db(self, processed: ProcessedAudio):
        """Almacenar en base de datos vectorial"""
        
        if self.vector_db_type == "pinecone":
            await self._store_pinecone(processed)
        elif self.vector_db_type == "pgvector":
            await self._store_pgvector(processed)
    
    async def _store_pinecone(self, processed: ProcessedAudio):
        """Almacenar en Pinecone"""
        self.logger.info("Almacenando en Pinecone...")
        
        metadata = {
            "source_id": processed.source.id,
            "channel_name": processed.source.channel_name,
            "transcription": processed.transcription[:1000],  # Primeros 1000 chars
            "temas": [t.value for t in processed.temas],
            "actors": [a.name for a in processed.actors],
            "keywords": processed.keywords,
            "processed_at": processed.processed_at.isoformat()
        }
        
        self.vector_index.upsert(
            vectors=[
                (
                    processed.source.id,
                    processed.embeddings.tolist(),
                    metadata
                )
            ]
        )
        
        self.logger.info("Datos almacenados en Pinecone")
    
    async def _store_pgvector(self, processed: ProcessedAudio):
        """Almacenar en PostgreSQL con pgvector"""
        self.logger.info("Almacenando en pgvector...")
        
        with self.pg_conn.cursor() as cur:
            cur.execute("""
                INSERT INTO audio_transcriptions 
                (source_id, channel_name, transcription, temas, actors, keywords, embedding, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                processed.source.id,
                processed.source.channel_name,
                processed.transcription,
                [t.value for t in processed.temas],
                [{"name": a.name, "mentions": a.mentions} for a in processed.actors],
                processed.keywords,
                processed.embeddings.tolist(),
                {"source_type": processed.source.source_type}
            ))
            self.pg_conn.commit()
        
        self.logger.info("Datos almacenados en pgvector")
    
    # ============================================
    # BÚSQUEDAS SEMÁNTICAS
    # ============================================
    
    async def semantic_search(
        self,
        query: str,
        top_k: int = 10,
        filter_temas: Optional[List[TemasCriticos]] = None
    ) -> List[Dict]:
        """Búsqueda semántica en transcripciones"""
        self.logger.info(f"Búsqueda semántica: {query}")
        
        # Generar embedding de la consulta
        query_embedding = self.embedder.encode(query)
        
        if self.vector_db_type == "pinecone":
            return await self._search_pinecone(query_embedding, top_k, filter_temas)
        elif self.vector_db_type == "pgvector":
            return await self._search_pgvector(query_embedding, top_k, filter_temas)
    
    async def _search_pinecone(
        self,
        query_embedding: np.ndarray,
        top_k: int,
        filter_temas: Optional[List[TemasCriticos]]
    ) -> List[Dict]:
        """Buscar en Pinecone"""
        
        filter_dict = {}
        if filter_temas:
            filter_dict["temas"] = {"$in": [t.value for t in filter_temas]}
        
        results = self.vector_index.query(
            vector=query_embedding.tolist(),
            top_k=top_k,
            include_metadata=True,
            filter=filter_dict if filter_dict else None
        )
        
        return [
            {
                "score": match.score,
                "channel": match.metadata.get("channel_name"),
                "transcription": match.metadata.get("transcription"),
                "temas": match.metadata.get("temas"),
                "actors": match.metadata.get("actors"),
            }
            for match in results.matches
        ]
    
    async def _search_pgvector(
        self,
        query_embedding: np.ndarray,
        top_k: int,
        filter_temas: Optional[List[TemasCriticos]]
    ) -> List[Dict]:
        """Buscar en pgvector"""
        
        with self.pg_conn.cursor() as cur:
            if filter_temas:
                temas_filter = [t.value for t in filter_temas]
                cur.execute("""
                    SELECT 
                        channel_name,
                        transcription,
                        temas,
                        actors,
                        1 - (embedding <=> %s) as similarity
                    FROM audio_transcriptions
                    WHERE temas && %s
                    ORDER BY embedding <=> %s
                    LIMIT %s
                """, (query_embedding.tolist(), temas_filter, query_embedding.tolist(), top_k))
            else:
                cur.execute("""
                    SELECT 
                        channel_name,
                        transcription,
                        temas,
                        actors,
                        1 - (embedding <=> %s) as similarity
                    FROM audio_transcriptions
                    ORDER BY embedding <=> %s
                    LIMIT %s
                """, (query_embedding.tolist(), query_embedding.tolist(), top_k))
            
            results = []
            for row in cur.fetchall():
                results.append({
                    "channel": row[0],
                    "transcription": row[1],
                    "temas": row[2],
                    "actors": row[3],
                    "score": row[4]
                })
            
            return results


# ============================================
# EJEMPLO DE USO
# ============================================

async def main():
    """Ejemplo de uso del pipeline"""
    
    # Inicializar pipeline
    pipeline = MediaMonitoringASRPipeline(
        asr_provider=ASRProvider.WHISPER,
        vector_db_type="pgvector",
        model_size="medium"
    )
    
    # Fuente de audio
    source = AudioSource(
        id="radio_mitre_2026_02_05",
        url="https://stream.radiomitre.com.ar/live",
        source_type="radio",
        channel_name="Radio Mitre AM 790",
        start_time=datetime.now()
    )
    
    # Procesar audio
    result = await pipeline.process_audio_stream(source)
    
    print(f"\n{'='*60}")
    print("RESULTADOS DEL PROCESAMIENTO")
    print(f"{'='*60}")
    print(f"Canal: {result.source.channel_name}")
    print(f"Duración: {len(result.segments)} segmentos")
    print(f"\nTemas identificados: {[t.value for t in result.temas]}")
    print(f"\nActores clave:")
    for actor in result.actors[:5]:
        print(f"  - {actor.name} ({actor.mentions} menciones)")
    print(f"\nKeywords: {', '.join(result.keywords[:10])}")
    
    # Búsqueda semántica
    print(f"\n{'='*60}")
    print("BÚSQUEDA SEMÁNTICA")
    print(f"{'='*60}")
    
    search_results = await pipeline.semantic_search(
        query="inflación y economía argentina",
        top_k=5,
        filter_temas=[TemasCriticos.ECONOMIA]
    )
    
    for i, result in enumerate(search_results, 1):
        print(f"\n{i}. {result['channel']} (Score: {result['score']:.2f})")
        print(f"   Temas: {', '.join(result['temas'])}")
        print(f"   Extracto: {result['transcription'][:200]}...")


if __name__ == "__main__":
    asyncio.run(main())
