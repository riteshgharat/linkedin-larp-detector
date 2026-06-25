class ServiceError(Exception):
    """Maps to a safe, client-facing HTTP error response."""

    def __init__(self, message: str, status_code: int = 503):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
