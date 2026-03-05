"""Database connection management for ACMA MCP server."""

import asyncio
from pathlib import Path

import structlog

logger = structlog.get_logger()


class DatabaseConnection:
    """Context manager for database connections."""

    def __init__(self, db_manager: "DatabaseManager"):
        self.db_manager = db_manager
        self.conn = None

    async def __aenter__(self):
        if not self.db_manager._initialized:
            raise RuntimeError("Database not initialized")

        self.conn = await self.db_manager._connection_pool.get()
        if self.conn is None:
            self.conn = await self.db_manager._create_connection()
        return self.conn

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        if self.conn:
            await self.db_manager._connection_pool.put(self.conn)


class DatabaseManager:
    """Manages SQLite database connections and operations."""

    def __init__(self, database_path: str, pool_size: int = 20):
        """Initialize database manager.

        Args:
            database_path: Path to SQLite database file
            pool_size: Maximum number of connections in pool
        """
        self.database_path = Path(database_path)
        self.pool_size = pool_size
        self._connection_pool: asyncio.Queue[any | None] = asyncio.Queue(
            maxsize=pool_size
        )
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize database and connection pool."""
        # Ensure database directory exists
        self.database_path.parent.mkdir(parents=True, exist_ok=True)

        # Create initial connection and setup schema
        conn = await self._create_connection()
        await self._setup_database(conn)

        # Fill connection pool
        for _ in range(self.pool_size - 1):
            pool_conn = await self._create_connection()
            await self._connection_pool.put(pool_conn)

        await self._connection_pool.put(conn)
        self._initialized = True
        logger.info("Database initialized", path=str(self.database_path))

    async def _create_connection(self):
        """Create a new database connection."""
        import aiosqlite

        conn = await aiosqlite.connect(self.database_path)
        # Enable WAL mode for better concurrency
        await conn.execute("PRAGMA journal_mode=WAL")
        # Enable foreign keys
        await conn.execute("PRAGMA foreign_keys=ON")
        # Set busy timeout
        await conn.execute("PRAGMA busy_timeout=30000")
        return conn

    async def _setup_database(self, conn) -> None:
        """Setup database schema and indexes."""
        # Create core tables
        await conn.executescript("""
            -- Licences table
            CREATE TABLE IF NOT EXISTS licence (
                licence_no TEXT PRIMARY KEY,
                client_no INTEGER NOT NULL,
                licence_type_name TEXT,
                licence_category_name TEXT,
                status TEXT,
                date_issued TEXT,
                date_of_expiry TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Clients table
            CREATE TABLE IF NOT EXISTS client (
                client_no INTEGER PRIMARY KEY,
                licencee TEXT NOT NULL,
                trading_name TEXT,
                address TEXT,
                abn TEXT,
                acn TEXT,
                cat_id INTEGER,
                client_type_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Sites table
            CREATE TABLE IF NOT EXISTS site (
                site_id TEXT PRIMARY KEY,
                latitude REAL,
                longitude REAL,
                address TEXT,
                elevation REAL,
                postcode TEXT,
                state TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Device details table
            CREATE TABLE IF NOT EXISTS device_details (
                device_id TEXT PRIMARY KEY,
                licence_no TEXT NOT NULL,
                site_id TEXT,
                frequency REAL,
                bandwidth REAL,
                power REAL,
                antenna_type TEXT,
                antenna_id TEXT,
                sv_id INTEGER,
                ss_id INTEGER,
                class_of_station_code TEXT,
                nature_of_service_id TEXT,
                sa_id INTEGER,
                tcs_id INTEGER,
                eqp_id INTEGER,
                related_efl_id INTEGER,
                azimuth REAL,
                height REAL,
                tilt REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (licence_no) REFERENCES licence(licence_no),
                FOREIGN KEY (site_id) REFERENCES site(site_id)
            );

            -- Authorized spectrum frequencies table
            CREATE TABLE IF NOT EXISTS auth_spectrum_freq (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                licence_no TEXT NOT NULL,
                frequency_start REAL NOT NULL,
                frequency_end REAL NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (licence_no) REFERENCES licence(licence_no)
            );

            -- Antenna patterns table (HRP data)
            CREATE TABLE IF NOT EXISTS antenna_pattern (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                device_registration_id TEXT,
                start_angle REAL,
                stop_angle REAL,
                power REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (device_id) REFERENCES device_details(device_id)
            );
        """)

        # Create indexes
        await conn.executescript("""
            CREATE INDEX IF NOT EXISTS idx_licence_client_no ON licence(client_no);
            CREATE INDEX IF NOT EXISTS idx_licence_status ON licence(status);
            CREATE INDEX IF NOT EXISTS idx_licence_type ON licence(licence_type_name);
            CREATE INDEX IF NOT EXISTS idx_device_licence_no ON device_details(licence_no);
            CREATE INDEX IF NOT EXISTS idx_device_site_id ON device_details(site_id);
            CREATE INDEX IF NOT EXISTS idx_device_frequency ON device_details(frequency);
            CREATE INDEX IF NOT EXISTS idx_spectrum_licence_no ON auth_spectrum_freq(licence_no);
            CREATE INDEX IF NOT EXISTS idx_spectrum_frequency_range ON auth_spectrum_freq(frequency_start, frequency_end);
            CREATE INDEX IF NOT EXISTS idx_antenna_pattern_device_id ON antenna_pattern(device_id);
        """)

        await conn.commit()
        logger.info("Database schema setup completed")

    def get_connection(self) -> DatabaseConnection:
        """Get a database connection from the pool."""
        return DatabaseConnection(self)

    async def execute_query(self, query: str, params: tuple = ()) -> list:
        """Execute a query and return results."""
        import aiosqlite

        async with self.get_connection() as conn:
            conn.row_factory = aiosqlite.Row
            cursor = await conn.execute(query, params)
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

    async def execute_update(self, query: str, params: tuple = ()) -> int:
        """Execute an update query and return affected rows."""
        async with self.get_connection() as conn:
            cursor = await conn.execute(query, params)
            await conn.commit()
            return cursor.rowcount

    async def close(self) -> None:
        """Close all database connections."""
        while not self._connection_pool.empty():
            conn = await self._connection_pool.get()
            if conn:
                await conn.close()
        self._initialized = False
        logger.info("Database connections closed")
