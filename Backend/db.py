import os
import mysql.connector
from mysql.connector import pooling
from dotenv import load_dotenv

load_dotenv()

_pool = None

def _get_pool():
    global _pool
    if _pool is None:
        _pool = pooling.MySQLConnectionPool(
            pool_name="studenthub_pool",
            pool_size=15,
            pool_reset_session=True,
            host=os.getenv("DB_HOST"),
            user=os.getenv("DB_USER"),
            password=os.getenv("DB_PASSWORD"),
            database=os.getenv("DB_NAME")
        )
    return _pool

def get_db():
    conn = None
    try:
        pool = _get_pool()
        conn = pool.get_connection()
    except Exception:
        # Fallback to direct connection if pool is exhausted or unavailable
        conn = mysql.connector.connect(
            host=os.getenv("DB_HOST"),
            user=os.getenv("DB_USER"),
            password=os.getenv("DB_PASSWORD"),
            database=os.getenv("DB_NAME")
        )

    try:
        from flask import has_request_context, g
        if has_request_context():
            if not hasattr(g, '_db_connections'):
                g._db_connections = []
            g._db_connections.append(conn)
    except Exception:
        pass

    return conn

def close_request_db(exception=None):
    """Automatically cleans up any unclosed DB connections in the current Flask request context."""
    try:
        from flask import g
        conns = getattr(g, '_db_connections', [])
        for conn in conns:
            try:
                if conn and conn.is_connected():
                    conn.close()
            except Exception:
                pass
    except Exception:
        pass