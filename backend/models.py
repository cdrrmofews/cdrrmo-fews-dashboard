from pydantic import BaseModel
from typing import Optional, Literal


class LoginRequest(BaseModel):
    username: str
    password: str

class CreateUserRequest(BaseModel):
    name:       str
    email:      str
    password:   str
    role:       str = "Operator"
    department: str = "Operations"
    phone:      Optional[str] = None

class UpdateUserRequest(BaseModel):
    role:       Optional[str] = None
    department: Optional[str] = None

class UpdateProfileRequest(BaseModel):
    name:  Optional[str] = None
    photo: Optional[str] = None

class ChangeEmailRequest(BaseModel):
    email: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password:     str

class ChangePhoneRequest(BaseModel):
    phone: str

class SmsEnabledRequest(BaseModel):
    sms_enabled: bool

class CreateLogRequest(BaseModel):
    station:   str = "System"
    type:      str = "system"
    message:   str
    user_name: Optional[str] = None

class SirenRequest(BaseModel):
    state: Literal["on", "off"]

class UpdateUnitRequest(BaseModel):
    installed_date:    Optional[str] = None
    technician:        Optional[str] = None
    description:       Optional[str] = None
    threshold_warning: Optional[int] = None
    threshold_danger:  Optional[int] = None

class PushSubscribeRequest(BaseModel):
    subscription: dict