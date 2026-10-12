# import bcrypt

# password = ""
# hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt())

# print(hashed.decode())

import bcrypt

password = ""
hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())
print(hashed.decode('utf-8'))