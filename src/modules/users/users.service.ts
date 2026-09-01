import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly repo: Repository<User>,
  ) {}

  findById(id: string): Promise<User | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.repo.findOne({ where: { email: email.toLowerCase() } });
  }

  /** Usernames are stored and compared lower-case, like emails. */
  findByUsername(username: string): Promise<User | null> {
    return this.repo.findOne({ where: { username: username.toLowerCase() } });
  }

  /**
   * Resolve a sign-in handle that may be either form. An '@' is the
   * discriminator: usernames are validated to exclude it (see CreateUserDto),
   * so the two namespaces cannot collide.
   */
  findByIdentifier(identifier: string): Promise<User | null> {
    const key = identifier.trim();
    return key.includes('@') ? this.findByEmail(key) : this.findByUsername(key);
  }

  async getByIdOrFail(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }
    return user;
  }

  save(user: User): Promise<User> {
    return this.repo.save(user);
  }

  createEntity(data: Partial<User>): User {
    return this.repo.create(data);
  }
}
